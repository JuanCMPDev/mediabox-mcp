import * as path from "node:path";
import type { OperationPlan, PlannedTarget, PlannedEffect } from "@mediabox/contracts";
import { buildOperationPlan } from "../planner.js";
import { mapNamespace } from "../../storage/namespace-map.js";
import { defaultRootFs } from "../../storage/rootfs.js";
import { isInternalPath } from "../../storage/quarantine.js";
import { resolveProfile, type MediaAction, type MediaProfile } from "../../storage/media-jobs.js";
import type { PlanScope } from "../../security/context.js";

export interface MediaFormatPlannerOptions {
  logicalPath: string;
  action: MediaAction;
  profileName?: string;
  scope: PlanScope;
  ttlMs?: number;
}

export interface MediaFormatPlanSummary {
  profile: string;
  action: MediaAction;
  irreversible: boolean;
  sourcePath: string;
  destinationPath: string;
  sourceBytes: number;
  stagingBytes: number;
  hardLinked: boolean;
}

function destinationFor(relativePath: string, profile: MediaProfile): string {
  const parsed = path.posix.parse(relativePath);
  return path.posix.join(parsed.dir, `${parsed.name}${profile.outputExtension}`);
}

export async function createMediaFormatPlan(
  options: MediaFormatPlannerOptions
): Promise<{ plan: OperationPlan; summary: MediaFormatPlanSummary }> {
  const profile = resolveProfile(options.action, options.profileName);
  const { rootId, relativePath } = mapNamespace(options.logicalPath);
  const resolved = await defaultRootFs.resolveWithinRoot(rootId, relativePath, { mustExist: true, expectKind: "file" });
  if (isInternalPath(resolved.relativePath)) {
    throw new Error(`Internal directory cannot be a media target: ${options.logicalPath}`);
  }
  const fileIdentity = await defaultRootFs.getFileIdentity(resolved.absolutePath);
  const sourceBytes = fileIdentity.sizeBytes ?? 0;
  const stagingBytes = Math.ceil(sourceBytes * profile.stagingFactor);
  const destination = destinationFor(resolved.relativePath, profile);

  const targets: PlannedTarget[] = [
    {
      service: "storage",
      rootId,
      relativePath: resolved.relativePath,
      fileIdentity,
      observedState: "present",
    },
  ];

  const effects: PlannedEffect[] = [
    {
      targetIndex: 0,
      serviceAction: `media.${profile.action}`,
      irreversibleLoss: profile.irreversible,
      tracksProfile: profile.name,
      destination,
      requiredResources: {
        estimatedDiskBytes: stagingBytes,
        selectedBytes: sourceBytes,
        reclaimableBytes: 0,
      },
    },
  ];

  const plan = buildOperationPlan({
    installationId: options.scope.installationId,
    ownerId: options.scope.ownerId,
    conversationId: options.scope.conversationId,
    operation: "media_format_conversion",
    targets,
    effects,
    preconditions: [
      {
        id: "prec_profile",
        type: "custom",
        description: `Closed profile ${profile.name}: ${profile.description}`,
        expected: profile.name,
        actual: profile.name,
      },
    ],
    recovery: {
      strategy: "restore_from_quarantine",
      instructions: "The original file is moved to <root>/.mediabox-trash/<planId>/ before the output is published and stays there for 7 days.",
    },
    ttlMs: options.ttlMs ?? 5 * 60 * 1000,
  });

  return {
    plan,
    summary: {
      profile: profile.name,
      action: profile.action,
      irreversible: profile.irreversible,
      sourcePath: `${rootId}:${resolved.relativePath}`,
      destinationPath: `${rootId}:${destination}`,
      sourceBytes,
      stagingBytes,
      hardLinked: (fileIdentity.nlink ?? 1) > 1,
    },
  };
}
