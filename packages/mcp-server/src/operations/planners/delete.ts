import fs from "node:fs/promises";
import * as path from "node:path";
import type { OperationPlan, PlannedTarget, PlannedEffect } from "@mediabox/contracts";
import { buildOperationPlan, computeProposalKey } from "../planner.js";
import { mapNamespace } from "../../storage/namespace-map.js";
import { defaultRootFs } from "../../storage/rootfs.js";
import { INTERNAL_DIR_NAMES, isInternalPath } from "../../storage/quarantine.js";
import type { PlanScope } from "../../security/context.js";

/**
 * Delete planner (Blueprint 4.3 / P04). The preview enumerates concrete files:
 * a directory is expanded at plan time into every regular file it contains,
 * one target and one `quarantine.move` effect per file, followed by
 * `quarantine.remove_empty_dir` effects (deepest first) that only succeed when
 * the directory is empty. Links, special files and unknown mappings fail the
 * whole plan; nothing is ever expanded again at execution time (INV-TARGET).
 */

export const MAX_FILES_PER_DELETE_PLAN = 500;

export type DeletePlannerErrorCode =
  | "ERR_TOO_MANY_FILES"
  | "ERR_LINK_IN_TARGET"
  | "ERR_UNSUPPORTED_ENTRY"
  | "ERR_EMPTY_SELECTION"
  | "ERR_INTERNAL_PATH";

export class DeletePlannerError extends Error {
  constructor(message: string, public readonly code: DeletePlannerErrorCode) {
    super(message);
    this.name = "DeletePlannerError";
  }
}

export interface DeletePlannerOptions {
  logicalPaths: string[];
  scope: PlanScope;
  ttlMs?: number;
}

export interface DeletePlanSummary {
  files: number;
  directories: number;
  selectedBytes: number;
  /** Quarantine never frees space on the volume. */
  reclaimableBytes: 0;
  hardLinkedFiles: number;
  paths: string[];
}

interface EnumeratedFile {
  rootId: string;
  relativePath: string;
  absolutePath: string;
}

interface EnumeratedDirectory {
  rootId: string;
  relativePath: string;
  depth: number;
}

async function enumerateDirectory(
  rootId: string,
  relativePath: string,
  absolutePath: string,
  files: EnumeratedFile[],
  directories: EnumeratedDirectory[],
  depth: number
): Promise<void> {
  const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
  for (const d of dirents) {
    const childRel = `${relativePath}/${d.name}`;
    const childAbs = path.join(absolutePath, d.name);
    if (d.isSymbolicLink()) {
      throw new DeletePlannerError(`Links are not allowed inside a delete target: ${childRel}`, "ERR_LINK_IN_TARGET");
    }
    if (d.isDirectory()) {
      if (INTERNAL_DIR_NAMES.has(d.name)) continue;
      directories.push({ rootId, relativePath: childRel, depth: depth + 1 });
      await enumerateDirectory(rootId, childRel, childAbs, files, directories, depth + 1);
    } else if (d.isFile()) {
      files.push({ rootId, relativePath: childRel, absolutePath: childAbs });
      if (files.length > MAX_FILES_PER_DELETE_PLAN) {
        throw new DeletePlannerError(
          `Selection exceeds ${MAX_FILES_PER_DELETE_PLAN} files; split the request`,
          "ERR_TOO_MANY_FILES"
        );
      }
    } else {
      throw new DeletePlannerError(`Unsupported filesystem entry: ${childRel}`, "ERR_UNSUPPORTED_ENTRY");
    }
  }
}

export async function createDeletePlan(options: DeletePlannerOptions): Promise<{ plan: OperationPlan; summary: DeletePlanSummary }> {
  const files: EnumeratedFile[] = [];
  const directories: EnumeratedDirectory[] = [];
  const seen = new Set<string>();

  for (const logicalPath of options.logicalPaths) {
    const { rootId, relativePath } = mapNamespace(logicalPath);
    const resolved = await defaultRootFs.resolveWithinRoot(rootId, relativePath, { mustExist: true });
    if (isInternalPath(resolved.relativePath)) {
      throw new DeletePlannerError(`Internal directory cannot be deleted: ${logicalPath}`, "ERR_INTERNAL_PATH");
    }
    const key = `${rootId}:${resolved.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (resolved.kind === "file") {
      files.push({ rootId, relativePath: resolved.relativePath, absolutePath: resolved.absolutePath });
    } else if (resolved.kind === "directory") {
      directories.push({ rootId, relativePath: resolved.relativePath, depth: 0 });
      await enumerateDirectory(rootId, resolved.relativePath, resolved.absolutePath, files, directories, 0);
    } else {
      throw new DeletePlannerError(`Unsupported filesystem entry: ${logicalPath}`, "ERR_UNSUPPORTED_ENTRY");
    }
    if (files.length > MAX_FILES_PER_DELETE_PLAN) {
      throw new DeletePlannerError(`Selection exceeds ${MAX_FILES_PER_DELETE_PLAN} files; split the request`, "ERR_TOO_MANY_FILES");
    }
  }

  if (files.length === 0 && directories.length === 0) {
    throw new DeletePlannerError("Nothing selected for deletion", "ERR_EMPTY_SELECTION");
  }

  const targets: PlannedTarget[] = [];
  const effects: PlannedEffect[] = [];
  let selectedBytes = 0;
  let hardLinkedFiles = 0;

  // De-duplicate files that were reached through more than one selected path.
  const uniqueFiles = new Map<string, EnumeratedFile>();
  for (const f of files) uniqueFiles.set(`${f.rootId}:${f.relativePath}`, f);

  for (const f of uniqueFiles.values()) {
    const identity = await defaultRootFs.getFileIdentity(f.absolutePath);
    const size = identity.sizeBytes ?? 0;
    selectedBytes += size;
    if ((identity.nlink ?? 1) > 1) hardLinkedFiles += 1;
    targets.push({
      service: "storage",
      rootId: f.rootId,
      relativePath: f.relativePath,
      fileIdentity: identity,
      observedState: "present",
    });
    effects.push({
      targetIndex: targets.length - 1,
      serviceAction: "quarantine.move",
      irreversibleLoss: false,
      requiredResources: {
        estimatedDiskBytes: 0,
        selectedBytes: size,
        reclaimableBytes: 0,
      },
    });
  }

  // Deepest directories first so parents become empty in order.
  const uniqueDirs = new Map<string, EnumeratedDirectory>();
  for (const d of directories) uniqueDirs.set(`${d.rootId}:${d.relativePath}`, d);
  const orderedDirs = [...uniqueDirs.values()].sort((a, b) => b.depth - a.depth || b.relativePath.length - a.relativePath.length);
  for (const d of orderedDirs) {
    targets.push({
      service: "storage",
      rootId: d.rootId,
      relativePath: d.relativePath,
      fileIdentity: { kind: "directory" },
      observedState: "present_directory",
    });
    effects.push({
      targetIndex: targets.length - 1,
      serviceAction: "quarantine.remove_empty_dir",
      irreversibleLoss: false,
    });
  }

  const plan = buildOperationPlan({
    installationId: options.scope.installationId,
    ownerId: options.scope.ownerId,
    conversationId: options.scope.conversationId,
    operation: "quarantine_files",
    proposalKey: computeProposalKey({
      installationId: options.scope.installationId,
      conversationId: options.scope.conversationId,
      operation: "quarantine_files",
      subjects: [...uniqueFiles.keys()].sort(),
    }),
    targets,
    effects,
    preconditions: [],
    recovery: {
      strategy: "restore_from_quarantine",
      instructions: "Files are moved to <root>/.mediabox-trash/<planId>/ and can be restored for 7 days; purge requires a separate approved plan.",
    },
    ttlMs: options.ttlMs ?? 5 * 60 * 1000,
  });

  return {
    plan,
    summary: {
      files: uniqueFiles.size,
      directories: orderedDirs.length,
      selectedBytes,
      reclaimableBytes: 0,
      hardLinkedFiles,
      paths: [...uniqueFiles.values()].map((f) => `${f.rootId}:${f.relativePath}`),
    },
  };
}
