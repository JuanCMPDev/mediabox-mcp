import { randomUUID } from "node:crypto";
import type { OperationPlanRecord } from "@mediabox/contracts";
import type { OperationStore } from "./store.js";

export type StepHandler = (
  step: { stepNumber: number; action: string; details?: Record<string, unknown> },
  context: { plan: OperationPlanRecord; signal?: AbortSignal }
) => Promise<Record<string, unknown> | void>;

export class OperationExecutor {
  private store: OperationStore;
  private workerId: string;
  private pollIntervalMs: number;
  private isRunning: boolean = false;
  private pollTimeout?: NodeJS.Timeout;
  private handlers: Map<string, StepHandler> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(store: OperationStore, options: { workerId?: string; pollIntervalMs?: number } = {}) {
    this.store = store;
    this.workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  registerStepHandler(action: string, handler: StepHandler): void {
    this.handlers.set(action, handler);
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
    // Abort running tasks
    for (const [, ac] of this.abortControllers) {
      ac.abort();
    }
    this.abortControllers.clear();
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.isRunning) return;
    this.pollTimeout = setTimeout(() => {
      this.pollAndExecute().finally(() => {
        if (this.isRunning) {
          this.scheduleNextPoll(this.pollIntervalMs);
        }
      });
    }, delayMs);
  }

  async pollAndExecute(): Promise<OperationPlanRecord | undefined> {
    const record = this.store.claimNextQueuedPlan(this.workerId, 30000);
    if (!record) return undefined;

    await this.executePlan(record);
    return record;
  }

  async executePlan(record: OperationPlanRecord): Promise<void> {
    const planId = record.plan.id;
    const ac = new AbortController();
    this.abortControllers.set(planId, ac);

    // Heartbeat lease renewal timer
    const leaseTimer = setInterval(() => {
      this.store.renewLease(planId, this.workerId, 30000);
    }, 10000);

    try {
      const steps = record.steps || [];
      let allSuccess = true;
      let failureReason: string | undefined;

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // Check if plan was cancelled in between steps
        const current = this.store.getPlan(planId);
        if (current?.status === "cancel_requested" || current?.status === "cancelled" || ac.signal.aborted) {
          this.store.finalizePlan(planId, "cancelled", "Execution stopped upon user cancellation");
          return;
        }

        this.store.updateStepProgress(planId, step.stepNumber, "running");

        try {
          const handler = this.handlers.get(step.action);
          let resultDetails: Record<string, unknown> | undefined;

          if (handler) {
            const res = await handler(
              { stepNumber: step.stepNumber, action: step.action, details: step.details },
              { plan: record, signal: ac.signal }
            );
            resultDetails = res ?? undefined;
          } else {
            // Default simulated pass-through if no custom handler is registered yet (pre-P04)
            resultDetails = { simulated: true, action: step.action };
          }

          this.store.updateStepProgress(planId, step.stepNumber, "completed", resultDetails);
        } catch (err: any) {
          allSuccess = false;
          failureReason = err?.message || String(err);
          this.store.updateStepProgress(planId, step.stepNumber, "failed", undefined, failureReason);
          break;
        }
      }

      if (allSuccess) {
        this.store.setPlanVerifying(planId);
        // Post-execution verification step
        this.store.finalizePlan(planId, "succeeded");
      } else {
        this.store.finalizePlan(planId, "failed", failureReason);
      }
    } catch (err: any) {
      this.store.finalizePlan(planId, "failed", err?.message || "Unexpected execution crash");
    } finally {
      clearInterval(leaseTimer);
      this.abortControllers.delete(planId);
    }
  }
}
