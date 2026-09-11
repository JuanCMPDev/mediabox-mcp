import type { OperationPlan, PlannedTarget, PlannedEffect } from "@mediabox/contracts";
import { buildOperationPlan } from "../planner.js";
import { defaultRootFs } from "../../storage/rootfs.js";
import { listQuarantine, QUARANTINE_DIR_NAME } from "../../storage/quarantine.js";
import type { PlanScope } from "../../security/context.js";

/**
 * Owner-only quarantine administration (Blueprint 4.3 / DEL-07): restore and
 * purge are separate plans. Purge is the only path that frees space and it is
 * never triggered by the retention TTL.
 */

export interface QuarantineAdminOptions {
  rootId: string;
  entryPaths: string[];
  scope: PlanScope;
  ttlMs?: number;
}

export interface QuarantineAdminSummary {
  entries: number;
  selectedBytes: number;
  reclaimableBytes: number;
}

async function loadEntries(rootId: string, entryPaths: string[]) {
  const listing = await listQuarantine(rootId);
  const byPath = new Map(listing.map((e) => [e.entryPath, e]));
  const wanted = [...new Set(entryPaths.map((p) => p.replace(/\\/g, "/").replace(/^\/+/, "")))];
  const entries = [];
  for (const entryPath of wanted) {
    const entry = byPath.get(entryPath);
    if (!entry) throw new Error(`Quarantine entry not found: ${entryPath}`);
    const resolved = await defaultRootFs.resolveWithinRoot(rootId, `${QUARANTINE_DIR_NAME}/${entryPath}`, {
      mustExist: true,
      expectKind: "file",
    });
    const identity = await defaultRootFs.getFileIdentity(resolved.absolutePath);
    entries.push({ entry, identity });
  }
  if (entries.length === 0) throw new Error("No quarantine entries selected");
  return entries;
}

export async function createQuarantineRestorePlan(options: QuarantineAdminOptions): Promise<{ plan: OperationPlan; summary: QuarantineAdminSummary }> {
  const entries = await loadEntries(options.rootId, options.entryPaths);
  const targets: PlannedTarget[] = [];
  const effects: PlannedEffect[] = [];
  let selectedBytes = 0;

  for (const { entry, identity } of entries) {
    selectedBytes += identity.sizeBytes ?? 0;
    targets.push({
      service: "storage",
      rootId: options.rootId,
      relativePath: entry.entryPath,
      fileIdentity: identity,
      observedState: "quarantined",
    });
    effects.push({
      targetIndex: targets.length - 1,
      serviceAction: "quarantine.restore",
      destination: entry.originalRelativePath,
      irreversibleLoss: false,
      requiredResources: { selectedBytes: identity.sizeBytes ?? 0, reclaimableBytes: 0, estimatedDiskBytes: 0 },
    });
  }

  const plan = buildOperationPlan({
    installationId: options.scope.installationId,
    ownerId: options.scope.ownerId,
    conversationId: options.scope.conversationId,
    operation: "quarantine_restore",
    targets,
    effects,
    recovery: { strategy: "none", instructions: "Restore never overwrites; a file that now occupies the original path blocks the restore." },
    ttlMs: options.ttlMs ?? 5 * 60 * 1000,
  });

  return { plan, summary: { entries: entries.length, selectedBytes, reclaimableBytes: 0 } };
}

export async function createQuarantinePurgePlan(options: QuarantineAdminOptions): Promise<{ plan: OperationPlan; summary: QuarantineAdminSummary }> {
  const entries = await loadEntries(options.rootId, options.entryPaths);
  const targets: PlannedTarget[] = [];
  const effects: PlannedEffect[] = [];
  let selectedBytes = 0;
  let reclaimableBytes = 0;

  for (const { entry, identity } of entries) {
    const size = identity.sizeBytes ?? 0;
    const reclaimable = (identity.nlink ?? 1) > 1 ? 0 : size;
    selectedBytes += size;
    reclaimableBytes += reclaimable;
    targets.push({
      service: "storage",
      rootId: options.rootId,
      relativePath: entry.entryPath,
      fileIdentity: identity,
      observedState: "quarantined",
    });
    effects.push({
      targetIndex: targets.length - 1,
      serviceAction: "quarantine.purge",
      irreversibleLoss: true,
      requiredResources: { selectedBytes: size, reclaimableBytes: reclaimable, estimatedDiskBytes: 0 },
    });
  }

  const plan = buildOperationPlan({
    installationId: options.scope.installationId,
    ownerId: options.scope.ownerId,
    conversationId: options.scope.conversationId,
    operation: "quarantine_purge",
    targets,
    effects,
    recovery: { strategy: "none", instructions: "Purge permanently deletes quarantined files; there is no recovery." },
    ttlMs: options.ttlMs ?? 5 * 60 * 1000,
  });

  return { plan, summary: { entries: entries.length, selectedBytes, reclaimableBytes } };
}
