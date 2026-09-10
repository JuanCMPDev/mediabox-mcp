import { randomUUID } from "node:crypto";
import type {
  OperationPlan,
  PlannedEffect,
  PlannedTarget,
  Precondition,
  RecoveryPlan,
} from "@mediabox/contracts";
import { computePlanManifestHash } from "./canonical-hash.js";

export const DEFAULT_PLAN_TTL_MS = 5 * 60 * 1000; // 5 minutes (§4.2)
export const DEFAULT_POLICY_VERSION = "1.0.0";

export interface CreatePlanInput {
  installationId: string;
  ownerId: string;
  conversationId: string;
  operation: string;
  targets: PlannedTarget[];
  effects: PlannedEffect[];
  preconditions?: Precondition[];
  recovery?: RecoveryPlan;
  ttlMs?: number;
  snapshotId?: string;
  policyVersion?: string;
}

/**
 * Builds and signs a canonical OperationPlan with default 5-minute TTL (§4.2).
 */
export function buildOperationPlan(input: CreatePlanInput): OperationPlan {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_PLAN_TTL_MS));

  const planWithoutHash: Omit<OperationPlan, "manifestHash"> = {
    schemaVersion: 1,
    id: `plan_${randomUUID()}`,
    installationId: input.installationId,
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    operation: input.operation,
    manifestVersion: 1,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    policyVersion: input.policyVersion ?? DEFAULT_POLICY_VERSION,
    snapshotId: input.snapshotId ?? `snap_${Date.now()}`,
    targets: input.targets,
    effects: input.effects,
    preconditions: input.preconditions ?? [],
    recovery: input.recovery ?? {
      strategy: "none",
    },
  };

  const manifestHash = computePlanManifestHash(planWithoutHash as any);

  return {
    ...planWithoutHash,
    manifestHash,
  };
}

/**
 * Validates a plan's preconditions against observed state.
 */
export function checkPlanPreconditions(plan: OperationPlan): { ok: boolean; failed: Precondition[] } {
  const failed: Precondition[] = [];
  for (const pc of plan.preconditions) {
    if (pc.actual !== undefined && pc.actual !== pc.expected) {
      failed.push(pc);
    }
  }
  return {
    ok: failed.length === 0,
    failed,
  };
}
