import type {
  OperationPlan,
  OperationPlanRecord,
  OperationPlanSummary,
  OperationStatus,
  OperationStepRecord,
  Principal,
} from "@mediabox/contracts";
import type { DatabaseAdapter } from "./sqlite/contract.js";
import { computePlanManifestHash } from "./canonical-hash.js";
import { initializeOperationsSchema } from "./schema.js";

export class OperationStoreError extends Error {
  constructor(message: string, public code: string, public status: number = 400) {
    super(message);
    this.name = "OperationStoreError";
  }
}

export class ManifestHashMismatchError extends OperationStoreError {
  constructor(message = "Provided manifest hash does not match stored plan hash") {
    super(message, "ERR_MANIFEST_HASH_MISMATCH", 409);
  }
}

export class PlanExpiredError extends OperationStoreError {
  constructor(message = "Operation plan has expired and cannot be approved") {
    super(message, "ERR_PLAN_EXPIRED", 410);
  }
}

export class ForbiddenScopeError extends OperationStoreError {
  constructor(message = "Principal cannot access or approve a plan belonging to another owner or scope") {
    super(message, "ERR_FORBIDDEN_SCOPE", 403);
  }
}

export class InvalidPlanStateError extends OperationStoreError {
  constructor(message: string) {
    super(message, "ERR_INVALID_PLAN_STATE", 400);
  }
}

export interface StoreListFilter {
  conversationId?: string;
  status?: OperationStatus;
  limit?: number;
  offset?: number;
}

export class OperationStore {
  private db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
    initializeOperationsSchema(this.db);
  }

  /**
   * Persists an OperationPlan with initial status (default "planned").
   * Verifies that the declared manifestHash matches the computed canonical hash (§4.2).
   */
  createPlan(plan: OperationPlan, initialStatus: OperationStatus = "planned"): OperationPlanRecord {
    const computedHash = computePlanManifestHash(plan);
    if (plan.manifestHash !== computedHash) {
      throw new ManifestHashMismatchError(
        `Plan manifestHash '${plan.manifestHash}' does not match computed canonical hash '${computedHash}'`
      );
    }

    const now = new Date().toISOString();
    const totalSteps = plan.effects.length > 0 ? plan.effects.length : 1;

    return this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO operation_plans (
            id, schema_version, installation_id, owner_id, conversation_id,
            operation, manifest_version, manifest_hash, created_at, expires_at,
            policy_version, snapshot_id, plan_json, status, total_steps, current_step
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          plan.id,
          plan.schemaVersion,
          plan.installationId,
          plan.ownerId,
          plan.conversationId,
          plan.operation,
          plan.manifestVersion,
          plan.manifestHash,
          plan.createdAt || now,
          plan.expiresAt,
          plan.policyVersion,
          plan.snapshotId,
          JSON.stringify(plan),
          initialStatus,
          totalSteps,
          0
        );

      // Create initial pending steps
      if (plan.effects.length > 0) {
        const stepStmt = this.db.prepare(`
          INSERT INTO operation_steps (plan_id, step_number, action, status)
          VALUES (?, ?, ?, ?)
        `);
        for (let i = 0; i < plan.effects.length; i++) {
          const effect = plan.effects[i];
          stepStmt.run(plan.id, i + 1, effect.serviceAction, "pending");
        }
      } else {
        this.db
          .prepare(`
            INSERT INTO operation_steps (plan_id, step_number, action, status)
            VALUES (?, ?, ?, ?)
          `)
          .run(plan.id, 1, plan.operation, "pending");
      }

      return this.getPlan(plan.id)!;
    });
  }

  /**
   * Retrieves an OperationPlan and steps.
   * Checks for expiration dynamically: if 'planned' or 'awaiting_approval' is past expiresAt,
   * marks it as 'expired' (OP-07).
   */
  getPlan(planId: string): OperationPlanRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM operation_plans WHERE id = ?`)
      .get<any>(planId);

    if (!row) return undefined;

    // Check expiration if not yet approved
    if (
      (row.status === "planned" || row.status === "awaiting_approval") &&
      new Date(row.expires_at).getTime() < Date.now()
    ) {
      this.db
        .prepare(`UPDATE operation_plans SET status = 'expired', status_reason = 'Plan TTL expired before approval' WHERE id = ?`)
        .run(planId);
      row.status = "expired";
      row.status_reason = "Plan TTL expired before approval";
    }

    const stepRows = this.db
      .prepare(`SELECT * FROM operation_steps WHERE plan_id = ? ORDER BY step_number ASC`)
      .all<any>(planId);

    const steps: OperationStepRecord[] = stepRows.map((s) => ({
      stepNumber: s.step_number,
      action: s.action,
      status: s.status,
      startedAt: s.started_at ?? undefined,
      completedAt: s.completed_at ?? undefined,
      error: s.error ?? undefined,
      details: s.details_json ? JSON.parse(s.details_json) : undefined,
    }));

    const plan: OperationPlan = JSON.parse(row.plan_json);

    return {
      plan,
      status: row.status as OperationStatus,
      statusReason: row.status_reason ?? undefined,
      approvedAt: row.approved_at ?? undefined,
      approvedBy: row.approved_by ?? undefined,
      queuedAt: row.queued_at ?? undefined,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      currentStep: row.current_step,
      totalSteps: row.total_steps,
      steps,
      leaseOwner: row.lease_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
    };
  }

  /**
   * Atomically approves and enqueues a plan in a single transaction (§4.2).
   * - Validates human owner principal (INV-APPROVAL, OP-01).
   * - Validates scope/conversation/installation matching (OP-05).
   * - Validates manifestHash matching and unexpired TTL (OP-03, OP-07).
   * - Idempotent: if already approved/queued/running, returns existing record without duplicating (OP-02).
   */
  approveAndEnqueue(planId: string, principal: Principal, manifestHash: string): OperationPlanRecord {
    // Only owner-ui or owner principal can approve (INV-APPROVAL / OP-01)
    if (principal.kind !== "owner-ui" && principal.kind !== "owner") {
      throw new OperationStoreError(
        `Principal kind '${principal.kind}' cannot approve plans. Approval requires human owner-ui authorization.`,
        "ERR_FORBIDDEN_AGENT",
        403
      );
    }

    return this.db.transaction(() => {
      const record = this.getPlan(planId);
      if (!record) {
        throw new OperationStoreError(`Operation plan '${planId}' not found`, "ERR_PLAN_NOT_FOUND", 404);
      }

      // Idempotency check: double click / replay returns existing operation (OP-02)
      if (
        record.status === "queued" ||
        record.status === "running" ||
        record.status === "verifying" ||
        record.status === "succeeded"
      ) {
        return record;
      }

      // Check tenant/scope: installation and owner/conversation (OP-05)
      if (record.plan.installationId !== principal.installationId) {
        throw new ForbiddenScopeError("Plan installationId does not match current installation");
      }

      // If the plan has an ownerId and principal has an id, ensure matching or admin authority
      if (record.plan.ownerId && principal.id && record.plan.ownerId !== principal.id && principal.kind !== "owner") {
        throw new ForbiddenScopeError("Plan does not belong to the approving owner");
      }

      // Check expiration
      if (record.status === "expired" || new Date(record.plan.expiresAt).getTime() < Date.now()) {
        throw new PlanExpiredError("Plan has expired and cannot be approved. A new plan must be generated.");
      }

      // Check manifest hash matching (OP-03)
      if (record.plan.manifestHash !== manifestHash) {
        throw new ManifestHashMismatchError(
          `Manifest hash mismatch: expected '${record.plan.manifestHash}', got '${manifestHash}'. Any modification requires a new plan.`
        );
      }

      // Check terminal states that disallow approval
      if (record.status === "rejected" || record.status === "cancelled" || record.status === "stale") {
        throw new InvalidPlanStateError(`Cannot approve plan in state '${record.status}'`);
      }

      const now = new Date().toISOString();

      this.db
        .prepare(`
          UPDATE operation_plans
          SET status = 'queued',
              approved_at = ?,
              approved_by = ?,
              queued_at = ?,
              status_reason = NULL
          WHERE id = ?
        `)
        .run(now, principal.id, now, planId);

      return this.getPlan(planId)!;
    });
  }

  /**
   * Rejects an unapproved plan.
   */
  rejectPlan(planId: string, principal: Principal, reason: string): OperationPlanRecord {
    if (principal.kind !== "owner-ui" && principal.kind !== "owner") {
      throw new OperationStoreError("Only owner can reject plans", "ERR_FORBIDDEN_AGENT", 403);
    }

    return this.db.transaction(() => {
      const record = this.getPlan(planId);
      if (!record) {
        throw new OperationStoreError(`Operation plan '${planId}' not found`, "ERR_PLAN_NOT_FOUND", 404);
      }

      if (record.status === "running" || record.status === "succeeded") {
        throw new InvalidPlanStateError(`Cannot reject plan in state '${record.status}'`);
      }

      this.db
        .prepare(`
          UPDATE operation_plans
          SET status = 'rejected',
              status_reason = ?
          WHERE id = ?
        `)
        .run(reason, planId);

      return this.getPlan(planId)!;
    });
  }

  /**
   * Cancels a plan. If running, transitions to cancel_requested; otherwise cancelled (OP-07).
   */
  cancelPlan(planId: string, principal: Principal, reason = "Cancelled by user"): OperationPlanRecord {
    if (principal.kind !== "owner-ui" && principal.kind !== "owner") {
      throw new OperationStoreError("Only owner can cancel plans", "ERR_FORBIDDEN_AGENT", 403);
    }

    return this.db.transaction(() => {
      const record = this.getPlan(planId);
      if (!record) {
        throw new OperationStoreError(`Operation plan '${planId}' not found`, "ERR_PLAN_NOT_FOUND", 404);
      }

      if (record.status === "succeeded" || record.status === "failed") {
        throw new InvalidPlanStateError(`Cannot cancel completed plan in state '${record.status}'`);
      }

      const newStatus: OperationStatus = record.status === "running" ? "cancel_requested" : "cancelled";

      this.db
        .prepare(`
          UPDATE operation_plans
          SET status = ?,
              status_reason = ?,
              finished_at = CASE WHEN ? = 'cancelled' THEN ? ELSE finished_at END
          WHERE id = ?
        `)
        .run(newStatus, reason, newStatus, new Date().toISOString(), planId);

      return this.getPlan(planId)!;
    });
  }

  /**
   * Claims the next queued plan using compare-and-set and a lease (§4.2).
   */
  claimNextQueuedPlan(workerId: string, leaseDurationMs = 30000): OperationPlanRecord | undefined {
    return this.db.transaction(() => {
      const candidate = this.db
        .prepare(`
          SELECT id FROM operation_plans
          WHERE status = 'queued'
          ORDER BY queued_at ASC
          LIMIT 1
        `)
        .get<{ id: string }>();

      if (!candidate) return undefined;

      const now = Date.now();
      const leaseExpiresAt = now + leaseDurationMs;
      const startedAt = new Date(now).toISOString();

      const res = this.db
        .prepare(`
          UPDATE operation_plans
          SET status = 'running',
              started_at = ?,
              lease_owner = ?,
              lease_expires_at = ?
          WHERE id = ? AND status = 'queued'
        `)
        .run(startedAt, workerId, leaseExpiresAt, candidate.id);

      if (res.changes === 0) {
        return undefined; // Raced with another claim
      }

      return this.getPlan(candidate.id);
    });
  }

  /**
   * Renews the lease for a running plan.
   */
  renewLease(planId: string, workerId: string, leaseDurationMs = 30000): boolean {
    const newExpiresAt = Date.now() + leaseDurationMs;
    const res = this.db
      .prepare(`
        UPDATE operation_plans
        SET lease_expires_at = ?
        WHERE id = ? AND lease_owner = ? AND (status = 'running' OR status = 'verifying')
      `)
      .run(newExpiresAt, planId, workerId);
    return res.changes > 0;
  }

  /**
   * Updates step execution progress and plan current_step.
   */
  updateStepProgress(
    planId: string,
    stepNumber: number,
    status: "pending" | "running" | "completed" | "failed",
    details?: Record<string, unknown>,
    error?: string
  ): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(`
          UPDATE operation_steps
          SET status = ?,
              started_at = CASE WHEN started_at IS NULL AND ? = 'running' THEN ? ELSE started_at END,
              completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END,
              details_json = ?,
              error = ?
          WHERE plan_id = ? AND step_number = ?
        `)
        .run(
          status,
          status,
          now,
          status,
          now,
          details ? JSON.stringify(details) : null,
          error ?? null,
          planId,
          stepNumber
        );

      this.db
        .prepare(`UPDATE operation_plans SET current_step = ? WHERE id = ?`)
        .run(stepNumber, planId);
    });
  }

  /**
   * Transitions a plan to verifying state.
   */
  setPlanVerifying(planId: string): void {
    this.db
      .prepare(`UPDATE operation_plans SET status = 'verifying' WHERE id = ?`)
      .run(planId);
  }

  /**
   * Finalizes plan execution (succeeded, failed, partial, unknown_outcome, cancelled, interrupted).
   */
  finalizePlan(
    planId: string,
    finalStatus: "succeeded" | "failed" | "partial" | "unknown_outcome" | "interrupted" | "cancelled",
    reason?: string
  ): OperationPlanRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE operation_plans
        SET status = ?,
            status_reason = ?,
            finished_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
        WHERE id = ?
      `)
      .run(finalStatus, reason ?? null, now, planId);

    return this.getPlan(planId)!;
  }

  /**
   * Lists operation summaries with optional filtering and pagination.
   */
  listPlans(filter: StoreListFilter = {}): OperationPlanSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.conversationId) {
      clauses.push("conversation_id = ?");
      params.push(filter.conversationId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }

    const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    params.push(limit, offset);

    const rows = this.db
      .prepare(`
        SELECT id, operation, status, status_reason, created_at, expires_at,
               manifest_hash, conversation_id, owner_id, approved_at, started_at, finished_at,
               total_steps, plan_json
        FROM operation_plans
        ${where}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all<any>(...params);

    return rows.map((r) => {
      let targetsCount = 0;
      let effectsCount = 0;
      try {
        const parsed = JSON.parse(r.plan_json);
        targetsCount = parsed.targets?.length ?? 0;
        effectsCount = parsed.effects?.length ?? 0;
      } catch {
        // ignore
      }

      return {
        id: r.id,
        operation: r.operation,
        status: r.status as OperationStatus,
        statusReason: r.status_reason ?? undefined,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        targetsCount,
        effectsCount,
        manifestHash: r.manifest_hash,
        conversationId: r.conversation_id,
        ownerId: r.owner_id,
        approvedAt: r.approved_at ?? undefined,
        startedAt: r.started_at ?? undefined,
        finishedAt: r.finished_at ?? undefined,
      };
    });
  }

  /**
   * Acquire a resource lease to serialize operations over the same entity/root (§4.2).
   */
  acquireResourceLease(resourceId: string, leaseOwner: string, leaseDurationMs = 30000): boolean {
    const now = Date.now();
    const expiresAt = now + leaseDurationMs;

    return this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT lease_owner, expires_at FROM operation_leases WHERE resource_id = ?`)
        .get<{ lease_owner: string; expires_at: number }>(resourceId);

      if (existing && existing.expires_at > now && existing.lease_owner !== leaseOwner) {
        return false; // Still held by someone else
      }

      this.db
        .prepare(`
          INSERT INTO operation_leases (resource_id, lease_owner, acquired_at, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(resource_id) DO UPDATE SET
            lease_owner = excluded.lease_owner,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
        `)
        .run(resourceId, leaseOwner, now, expiresAt);

      return true;
    });
  }

  /**
   * Releases a previously acquired resource lease.
   */
  releaseResourceLease(resourceId: string, leaseOwner: string): void {
    this.db
      .prepare(`DELETE FROM operation_leases WHERE resource_id = ? AND lease_owner = ?`)
      .run(resourceId, leaseOwner);
  }
}
