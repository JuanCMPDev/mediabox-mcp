import type { OperationPlan, PlannedTarget, PlannedEffect } from "@mediabox/contracts";
import { buildOperationPlan } from "../planner.js";
import { resolveNamespacePath, mapNamespace } from "../../storage/namespace-map.js";
import { defaultRootFs } from "../../storage/rootfs.js";

export interface DeletePlannerOptions {
  logicalPaths: string[];
  conversationId?: string;
  ownerId?: string;
}

export async function createDeletePlan(options: DeletePlannerOptions): Promise<OperationPlan> {
  const targets: PlannedTarget[] = [];
  const effects: PlannedEffect[] = [];

  let estimatedFreedBytes = 0;

  for (let i = 0; i < options.logicalPaths.length; i++) {
    const logicalPath = options.logicalPaths[i];
    const { rootId, relativePath } = mapNamespace(logicalPath);
    
    // Validate path escapes and get file identity
    const absolutePath = await defaultRootFs.resolveWithinRoot(rootId, relativePath);
    const fileIdentity = await defaultRootFs.getFileIdentity(absolutePath);

    estimatedFreedBytes += (fileIdentity.sizeBytes || 0);

    const target: PlannedTarget = {
      service: "storage",
      rootId,
      relativePath,
      fileIdentity,
      observedState: "present",
    };

    targets.push(target);

    // Effect: quarantine
    effects.push({
      targetIndex: i,
      serviceAction: "quarantine.move",
      irreversibleLoss: false,
      requiredResources: {
        estimatedDiskBytes: -(fileIdentity.sizeBytes || 0), // Frees space logically
      },
    });
  }

  return buildOperationPlan({
    installationId: "local",
    ownerId: options.ownerId || "local",
    conversationId: options.conversationId || "local",
    operation: "quarantine_files",
    targets,
    effects,
    preconditions: [], // Could add preconditions that files must exist
    ttlMs: 5 * 60 * 1000,
  });
}
