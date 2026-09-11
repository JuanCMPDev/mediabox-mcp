import { Router } from "express";
import type { OperationStore } from "../operations/store.js";
import { OperationStoreError } from "../operations/store.js";
import { requirePolicy } from "../security/policy.js";
import { buildOperationPlan } from "../operations/planner.js";
import { resolvePlanOwnerId } from "../security/context.js";
import { listQuarantine } from "../storage/quarantine.js";
import { defaultRootFs } from "../storage/rootfs.js";
import { createQuarantineRestorePlan, createQuarantinePurgePlan } from "../operations/planners/quarantine-admin.js";
import type { OperationPlan, OperationStatus } from "@mediabox/contracts";

const KNOWN_STATUSES: ReadonlySet<string> = new Set<OperationStatus>([
  "planned", "awaiting_approval", "queued", "running", "verifying", "succeeded", "rejected", "expired",
  "stale", "cancel_requested", "cancelled", "failed", "partial", "unknown_outcome", "interrupted",
]);

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof OperationStoreError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const code = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code === "string" && code.startsWith("ERR_")) {
    res.status(400).json({ error: message, code });
    return;
  }
  res.status(500).json({ error: message || "Internal server error", code: "ERR_INTERNAL" });
}

export function createOperationsRouter(store: OperationStore): Router {
  const router = Router();

  /**
   * POST /api/operations/plans
   * Proposes/registers a new plan. Permitted for agent-session and owner-ui.
   * The plan scope (installation, owner) always comes from the authenticated
   * principal, never from the body (INV-AUTH / OP-05).
   */
  router.post("/plans", requirePolicy("operations", "propose"), (req, res) => {
    try {
      const principal = req.principal!;
      const body = req.body ?? {};

      if (!body.operation || !Array.isArray(body.targets) || !Array.isArray(body.effects)) {
        res.status(400).json({
          error: "Invalid plan payload: operation, targets, and effects are required",
          code: "ERR_INVALID_PLAN_PAYLOAD",
        });
        return;
      }

      const ownerId = resolvePlanOwnerId(principal);
      let plan: OperationPlan;
      if (body.manifestHash) {
        // Plan already built and hashed by the caller: its scope must match the caller.
        if (body.installationId !== principal.installationId || body.ownerId !== ownerId) {
          res.status(400).json({
            error: "Plan scope does not match the authenticated principal",
            code: "ERR_PLAN_SCOPE_MISMATCH",
          });
          return;
        }
        plan = body as OperationPlan;
      } else {
        plan = buildOperationPlan({
          installationId: principal.installationId,
          ownerId,
          conversationId: typeof body.conversationId === "string" && body.conversationId ? body.conversationId : principal.sessionId,
          operation: body.operation,
          targets: body.targets,
          effects: body.effects,
          preconditions: body.preconditions,
          recovery: body.recovery,
          ttlMs: body.ttlMs,
        });
      }

      const record = store.createPlan(plan, "awaiting_approval");
      res.status(201).json(record);
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * GET /api/operations/plans
   * Lists operation summaries. `status` filters one status, `statuses` a comma-separated set.
   */
  router.get("/plans", requirePolicy("operations", "read"), (req, res) => {
    try {
      const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : undefined;
      const status = typeof req.query.status === "string" && KNOWN_STATUSES.has(req.query.status) ? (req.query.status as OperationStatus) : undefined;
      const statuses =
        typeof req.query.statuses === "string"
          ? (req.query.statuses.split(",").map((s) => s.trim()).filter((s) => KNOWN_STATUSES.has(s)) as OperationStatus[])
          : undefined;
      const limit = req.query.limit ? Math.min(Math.max(1, parseInt(String(req.query.limit), 10) || 50), 200) : undefined;
      const offset = req.query.offset ? Math.max(0, parseInt(String(req.query.offset), 10) || 0) : undefined;

      const plans = store.listPlans({ conversationId, status, statuses, limit, offset });
      res.json({ plans });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/plans/:id", requirePolicy("operations", "read"), (req, res) => {
    try {
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const plan = store.getPlan(planId);
      if (!plan) {
        res.status(404).json({ error: "Operation plan not found", code: "ERR_PLAN_NOT_FOUND" });
        return;
      }
      res.json(plan);
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * POST /api/operations/plans/:id/approve — owner only (INV-APPROVAL).
   */
  router.post("/plans/:id/approve", requirePolicy("operations", "approve"), (req, res) => {
    try {
      const principal = req.principal!;
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { manifestHash } = req.body || {};
      if (!manifestHash) {
        res.status(400).json({ error: "manifestHash is required for operation approval", code: "ERR_MANIFEST_HASH_REQUIRED" });
        return;
      }
      res.json(store.approveAndEnqueue(planId, principal, manifestHash));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/plans/:id/reject", requirePolicy("operations", "approve"), (req, res) => {
    try {
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      res.json(store.rejectPlan(planId, req.principal!, req.body?.reason || "Rejected by owner"));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/plans/:id/cancel", requirePolicy("operations", "approve"), (req, res) => {
    try {
      const planId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      res.json(store.cancelPlan(planId, req.principal!, req.body?.reason || "Cancelled by owner"));
    } catch (err) {
      sendError(res, err);
    }
  });

  // ── Quarantine administration (owner only, DEL-07) ─────────────────────
  router.get("/quarantine", requirePolicy("operations", "approve"), async (req, res) => {
    try {
      const rootIds = typeof req.query.rootId === "string" ? [req.query.rootId] : defaultRootFs.listRoots().map((r) => r.rootId);
      const entries = [];
      const sources = [];
      for (const rootId of rootIds) {
        try {
          entries.push(...(await listQuarantine(rootId)));
          sources.push({ rootId, completeness: "complete" });
        } catch (err) {
          sources.push({ rootId, completeness: "unavailable", error: (err as Error).message });
        }
      }
      res.json({ entries, sources });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/quarantine/restore", requirePolicy("operations", "approve"), async (req, res) => {
    try {
      const principal = req.principal!;
      const { rootId, entryPaths } = req.body ?? {};
      if (typeof rootId !== "string" || !Array.isArray(entryPaths) || entryPaths.length === 0) {
        res.status(400).json({ error: "rootId and entryPaths[] are required", code: "ERR_INVALID_PAYLOAD" });
        return;
      }
      const { plan, summary } = await createQuarantineRestorePlan({
        rootId,
        entryPaths: entryPaths.map(String),
        scope: { installationId: principal.installationId, ownerId: resolvePlanOwnerId(principal), conversationId: principal.sessionId },
      });
      const record = store.createPlan(plan, "awaiting_approval");
      res.status(201).json({ ...record, summary });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/quarantine/purge", requirePolicy("operations", "approve"), async (req, res) => {
    try {
      const principal = req.principal!;
      const { rootId, entryPaths } = req.body ?? {};
      if (typeof rootId !== "string" || !Array.isArray(entryPaths) || entryPaths.length === 0) {
        res.status(400).json({ error: "rootId and entryPaths[] are required", code: "ERR_INVALID_PAYLOAD" });
        return;
      }
      const { plan, summary } = await createQuarantinePurgePlan({
        rootId,
        entryPaths: entryPaths.map(String),
        scope: { installationId: principal.installationId, ownerId: resolvePlanOwnerId(principal), conversationId: principal.sessionId },
      });
      const record = store.createPlan(plan, "awaiting_approval");
      res.status(201).json({ ...record, summary });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
