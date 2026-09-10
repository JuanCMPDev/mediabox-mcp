import type { OperationPlan, PlannedTarget, PlannedEffect } from "@mediabox/contracts";
import { buildOperationPlan } from "../planner.js";
import { mapNamespace } from "../../storage/namespace-map.js";
import { defaultRootFs } from "../../storage/rootfs.js";
import type { MediaFormatProfile } from "../../storage/media-jobs.js";

export interface MediaFormatPlannerOptions {
  logicalPath: string;
  profile: MediaFormatProfile;
  conversationId?: string;
  ownerId?: string;
}

export async function createMediaFormatPlan(options: MediaFormatPlannerOptions): Promise<OperationPlan> {
  const { logicalPath, profile } = options;
  const { rootId, relativePath } = mapNamespace(logicalPath);
  
  const absolutePath = await defaultRootFs.resolveWithinRoot(rootId, relativePath);
  const fileIdentity = await defaultRootFs.getFileIdentity(absolutePath);

  const targets: PlannedTarget[] = [{
    service: "storage",
    rootId,
    relativePath,
    fileIdentity,
    observedState: "present",
  }];

  const irreversible = profile.action === "transcode" || profile.action === "subtitle-convert";

  const effects: PlannedEffect[] = [{
    targetIndex: 0,
    serviceAction: `media.${profile.action}`,
    irreversibleLoss: irreversible,
    tracksProfile: profile.profileName,
    requiredResources: {
      estimatedDiskBytes: fileIdentity.sizeBytes, // Requires staging space
    },
  }];

  return buildOperationPlan({
    installationId: "local",
    ownerId: options.ownerId || "local",
    conversationId: options.conversationId || "local",
    operation: "media_format_conversion",
    targets,
    effects,
    ttlMs: 5 * 60 * 1000,
  });
}
