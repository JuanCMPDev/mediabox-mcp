import { createHash } from "node:crypto";
import type { OperationPlan } from "@mediabox/contracts";

/**
 * Deterministic object serializer for cryptographic hashing.
 * Recursively sorts all keys and handles arrays stably.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJsonStringify(item)).join(",") + "]";
  }

  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    return JSON.stringify(key) + ":" + canonicalJsonStringify(val);
  });

  return "{" + pairs.join(",") + "}";
}

/**
 * Computes the canonical SHA-256 hash of an OperationPlan manifest according to §4.2.
 * Includes all relevant targets, effects, preconditions, policyVersion, and destinations.
 */
export function computePlanManifestHash(
  plan: Pick<
    OperationPlan,
    | "schemaVersion"
    | "operation"
    | "installationId"
    | "ownerId"
    | "conversationId"
    | "policyVersion"
    | "targets"
    | "effects"
    | "preconditions"
    | "recovery"
  >
): string {
  const canonicalPayload = {
    schemaVersion: plan.schemaVersion,
    operation: plan.operation,
    installationId: plan.installationId,
    ownerId: plan.ownerId,
    conversationId: plan.conversationId,
    policyVersion: plan.policyVersion,
    targets: plan.targets,
    effects: plan.effects,
    preconditions: plan.preconditions,
    recovery: plan.recovery,
  };

  const canonicalString = canonicalJsonStringify(canonicalPayload);
  return createHash("sha256").update(canonicalString).digest("hex");
}
