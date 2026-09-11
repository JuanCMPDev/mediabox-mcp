import { randomUUID } from "node:crypto";
import type { OperationPlanRecord, PlannedEffect, PlannedTarget } from "@mediabox/contracts";
import type { OperationStore } from "./store.js";

/**
 * Thrown by a step handler when an external effect may or may not have been
 * applied (timeout after submission). The plan ends in `unknown_outcome` and
 * is never retried automatically (Blueprint 4.2 / INV-RECOVERY).
 */
export class UnknownOutcomeError extends Error {
  readonly outcome = "unknown_outcome" as const;
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "UnknownOutcomeError";
  }
}

export interface StepContext {
  plan: OperationPlanRecord;
  /** Effect the step was created from (steps map 1:1 to effects, in order). */
  effect?: PlannedEffect;
  target?: PlannedTarget;
  signal: AbortSignal;
}

export type StepHandler = (
  step: { stepNumber: number; action: string; details?: Record<string, unknown> },
  context: StepContext
) => Promise<Record<string, unknown> | void>;

export interface VerificationResult {
  ok: boolean;
  reason?: string;
  /** When false the plan ends `failed` instead of `partial` on a negative verification. */
  partial?: boolean;
}

export type PlanVerifier = (
  record: OperationPlanRecord,
  stepResults: Array<Record<string, unknown> | undefined>
) => Promise<VerificationResult>;

export type FinalizedListener = (record: OperationPlanRecord) => void;

const RESOURCE_LEASE_MS = 10 * 60 * 1000;
const PLAN_LEASE_MS = 30_000;
const HEARTBEAT_MS = 5_000;

export function resourceIdsForPlan(record: OperationPlanRecord): string[] {
  const ids = new Set<string>();
  for (const t of record.plan.targets) {
    ids.add(`${t.service}:${t.rootId}:${t.relativePath}`);
  }
  return [...ids];
}

export class OperationExecutor {
  private store: OperationStore;
  private workerId: string;
  private pollIntervalMs: number;
  private isRunning = false;
  private pollTimeout?: NodeJS.Timeout;
  private handlers = new Map<string, StepHandler>();
  private verifiers = new Map<string, PlanVerifier>();
  private listeners: FinalizedListener[] = [];
  private abortControllers = new Map<string, AbortController>();

  private heartbeatMs: number;

  constructor(store: OperationStore, options: { workerId?: string; pollIntervalMs?: number; heartbeatMs?: number } = {}) {
    this.store = store;
    this.workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  registerStepHandler(action: string, handler: StepHandler): void {
    this.handlers.set(action, handler);
  }

  hasStepHandler(action: string): boolean {
    return this.handlers.has(action);
  }

  registerVerifier(operation: string, verifier: PlanVerifier): void {
    this.verifiers.set(operation, verifier);
  }

  onPlanFinalized(listener: FinalizedListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextPoll(0);
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }
    for (const [, ac] of this.abortControllers) ac.abort();
    this.abortControllers.clear();
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    this.pollTimeout = setTimeout(() => {
      this.pollAndExecute()
        .catch(() => {})
        .finally(() => {
          if (this.isRunning) this.scheduleNextPoll(this.pollIntervalMs);
        });
    }, delayMs);
    this.pollTimeout.unref?.();
  }

  async pollAndExecute(): Promise<OperationPlanRecord | undefined> {
    const record = this.store.claimNextQueuedPlan(this.workerId, PLAN_LEASE_MS);
    if (!record) return undefined;
    await this.executePlan(record);
    return this.store.getPlan(record.plan.id);
  }

  private finalize(planId: string, status: Parameters<OperationStore["finalizePlan"]>[1], reason?: string): OperationPlanRecord {
    const record = this.store.finalizePlan(planId, status, reason);
    for (const l of this.listeners) {
      try {
        l(record);
      } catch {
        // listeners must never break the executor
      }
    }
    return record;
  }

  async executePlan(record: OperationPlanRecord): Promise<void> {
    const planId = record.plan.id;
    const plan = record.plan;

    // Serialise work on the same entity/root (Blueprint 4.2).
    const resources = resourceIdsForPlan(record);
    const acquired: string[] = [];
    for (const r of resources) {
      if (this.store.acquireResourceLease(r, planId, RESOURCE_LEASE_MS)) {
        acquired.push(r);
      } else {
        for (const a of acquired) this.store.releaseResourceLease(a, planId);
        this.store.requeuePlan(planId, this.workerId, `Waiting for resource lease on ${r}`);
        return;
      }
    }

    const ac = new AbortController();
    this.abortControllers.set(planId, ac);

    const heartbeat = setInterval(() => {
      this.store.renewLease(planId, this.workerId, PLAN_LEASE_MS);
      const current = this.store.getPlan(planId);
      if (current?.status === "cancel_requested" && !ac.signal.aborted) {
        ac.abort();
      }
    }, this.heartbeatMs);
    heartbeat.unref?.();

    const stepResults: Array<Record<string, unknown> | undefined> = [];
    let completedSteps = 0;

    try {
      const steps = record.steps ?? [];

      for (const step of steps) {
        const current = this.store.getPlan(planId);
        if (current?.status === "cancel_requested" || current?.status === "cancelled" || ac.signal.aborted) {
          this.finalize(planId, "cancelled", `Cancelled before step ${step.stepNumber} started`);
          return;
        }

        const handler = this.handlers.get(step.action);
        if (!handler) {
          // Unknown actions fail closed: nothing is simulated (Blueprint P00 / INV-APPROVAL).
          this.store.updateStepProgress(planId, step.stepNumber, "failed", undefined, `ERR_NO_HANDLER: no handler registered for action '${step.action}'`);
          this.finalize(planId, completedSteps > 0 ? "partial" : "failed", `No handler registered for action '${step.action}'`);
          return;
        }

        const effect = plan.effects[step.stepNumber - 1];
        const target = effect && effect.targetIndex !== undefined ? plan.targets[effect.targetIndex] : undefined;

        this.store.updateStepProgress(planId, step.stepNumber, "running");
        try {
          const res = await handler(
            { stepNumber: step.stepNumber, action: step.action, details: step.details },
            { plan: record, effect, target, signal: ac.signal }
          );
          const details = res ?? undefined;
          stepResults.push(details);
          this.store.updateStepProgress(planId, step.stepNumber, "completed", details);
          completedSteps += 1;
        } catch (err: any) {
          const message = err?.message || String(err);
          if (ac.signal.aborted) {
            this.store.updateStepProgress(planId, step.stepNumber, "failed", undefined, `Cancelled while running: ${message}`);
            this.finalize(planId, "cancelled", `Cancelled during step ${step.stepNumber}; the running process was terminated`);
            return;
          }
          if (err instanceof UnknownOutcomeError) {
            this.store.updateStepProgress(planId, step.stepNumber, "failed", err.details, `unknown_outcome: ${message}`);
            this.finalize(planId, "unknown_outcome", message);
            return;
          }
          this.store.updateStepProgress(planId, step.stepNumber, "failed", undefined, message);
          this.finalize(planId, completedSteps > 0 ? "partial" : "failed", `Step ${step.stepNumber} (${step.action}) failed: ${message}`);
          return;
        }
      }

      this.store.setPlanVerifying(planId);
      const verifier = this.verifiers.get(plan.operation);
      if (!verifier) {
        this.finalize(planId, "succeeded", "All steps completed; no post-verification registered for this operation");
        return;
      }
      const verifying = this.store.getPlan(planId) ?? record;
      let result: VerificationResult;
      try {
        result = await verifier(verifying, stepResults);
      } catch (err: any) {
        result = { ok: false, reason: `Verification threw: ${err?.message ?? err}`, partial: true };
      }
      if (result.ok) {
        this.finalize(planId, "succeeded", result.reason);
      } else {
        this.finalize(planId, result.partial === false ? "failed" : "partial", result.reason ?? "Post-execution verification failed");
      }
    } catch (err: any) {
      this.finalize(planId, "failed", err?.message || "Unexpected execution crash");
    } finally {
      clearInterval(heartbeat);
      this.abortControllers.delete(planId);
      for (const r of acquired) this.store.releaseResourceLease(r, planId);
    }
  }
}
