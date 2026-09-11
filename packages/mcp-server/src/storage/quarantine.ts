import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { PlannedTargetFileIdentity, QuarantineEntry } from "@mediabox/contracts";
import { defaultRootFs, RootFsError } from "./rootfs.js";

/**
 * Quarantine (Blueprint 4.3 / P04): the normal "delete" is a per-file move into
 * `<root>/.mediabox-trash/<planId>/<original relative path>` on the same
 * filesystem, with a manifest next to the file. Moving to quarantine never
 * frees space on that volume; purge is a separate owner-approved operation and
 * the retention TTL never purges on its own. Restore never overwrites a file
 * that has since taken the original path.
 */

export const QUARANTINE_DIR_NAME = ".mediabox-trash";
export const STAGING_DIR_NAME = ".mediabox-staging";
export const QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const INTERNAL_DIR_NAMES: ReadonlySet<string> = new Set([QUARANTINE_DIR_NAME, STAGING_DIR_NAME]);

export type QuarantineErrorCode =
  | "ERR_QUARANTINE_TARGET_EXISTS"
  | "ERR_QUARANTINE_CROSS_DEVICE"
  | "ERR_QUARANTINE_INTERNAL_PATH"
  | "ERR_RESTORE_TARGET_EXISTS"
  | "ERR_QUARANTINE_ENTRY_NOT_FOUND"
  | "ERR_QUARANTINE_ENTRY_INVALID";

export class QuarantineError extends Error {
  constructor(message: string, public readonly code: QuarantineErrorCode) {
    super(message);
    this.name = "QuarantineError";
  }
}

export interface QuarantineManifest {
  schemaVersion: 1;
  rootId: string;
  originalRelativePath: string;
  planId?: string;
  quarantinedAt: string;
  expiresAt: string;
  sizeBytes: number;
  nlink: number;
  /** Bytes a purge would actually free (0 when the inode is linked elsewhere). */
  reclaimableOnPurgeBytes: number;
  identity: PlannedTargetFileIdentity;
}

export interface QuarantineResult extends QuarantineManifest {
  /** Path of the quarantined file relative to the root's trash directory. */
  entryPath: string;
}

export interface QuarantineOptions {
  planId?: string;
  /** Identity captured at plan time; the move is refused when it no longer matches (INV-TARGET / DEL-03). */
  expectedIdentity?: PlannedTargetFileIdentity;
}

function manifestPathFor(absoluteEntry: string): string {
  return `${absoluteEntry}.manifest.json`;
}

export function isInternalPath(relativePath: string): boolean {
  const first = relativePath.replace(/\\/g, "/").split("/")[0];
  return INTERNAL_DIR_NAMES.has(first);
}

function assertNotInternal(relativePath: string): void {
  if (isInternalPath(relativePath)) {
    throw new QuarantineError(`Internal directory cannot be a target: ${relativePath}`, "ERR_QUARANTINE_INTERNAL_PATH");
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export function reclaimableBytes(sizeBytes: number, nlink: number): number {
  return nlink > 1 ? 0 : sizeBytes;
}

/** Moves one regular file into the root's quarantine directory. */
export async function quarantineFile(rootId: string, relativePath: string, opts: QuarantineOptions = {}): Promise<QuarantineResult> {
  const resolved = await defaultRootFs.resolveWithinRoot(rootId, relativePath, { mustExist: true, expectKind: "file" });
  assertNotInternal(resolved.relativePath);

  if (opts.expectedIdentity) {
    await defaultRootFs.assertIdentity(resolved.absolutePath, opts.expectedIdentity);
  }

  const identity = await defaultRootFs.getFileIdentity(resolved.absolutePath);
  const sizeBytes = identity.sizeBytes ?? 0;
  const nlink = identity.nlink ?? 1;

  const entryPath = `${opts.planId ?? "manual"}/${resolved.relativePath}`;
  const trashRoot = path.join(resolved.canonicalRoot, QUARANTINE_DIR_NAME);
  const destination = path.join(trashRoot, ...entryPath.split("/"));

  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (await pathExists(destination)) {
    throw new QuarantineError(`Quarantine entry already exists: ${entryPath}`, "ERR_QUARANTINE_TARGET_EXISTS");
  }

  // Re-check identity right before the effect to narrow the TOCTOU window.
  if (opts.expectedIdentity) {
    await defaultRootFs.assertIdentity(resolved.absolutePath, opts.expectedIdentity);
  }

  try {
    await fs.rename(resolved.absolutePath, destination);
  } catch (err: any) {
    if (err?.code === "EXDEV") {
      throw new QuarantineError(
        `Quarantine directory is on a different filesystem than ${rootId}; refusing copy+delete`,
        "ERR_QUARANTINE_CROSS_DEVICE"
      );
    }
    throw err;
  }

  const now = Date.now();
  const manifest: QuarantineManifest = {
    schemaVersion: 1,
    rootId,
    originalRelativePath: resolved.relativePath,
    planId: opts.planId,
    quarantinedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUARANTINE_RETENTION_MS).toISOString(),
    sizeBytes,
    nlink,
    reclaimableOnPurgeBytes: reclaimableBytes(sizeBytes, nlink),
    identity,
  };
  await fs.writeFile(manifestPathFor(destination), JSON.stringify(manifest, null, 2), "utf8");

  return { ...manifest, entryPath };
}

export interface RemoveDirectoryResult {
  removed: boolean;
  reason?: "ERR_DIRECTORY_NOT_EMPTY" | "ERR_PATH_NOT_FOUND";
}

/**
 * Removes a directory only when it is empty. A directory that still holds
 * anything (including files added after the plan) is left untouched.
 */
export async function removeEmptyDirectory(rootId: string, relativePath: string): Promise<RemoveDirectoryResult> {
  const resolved = await defaultRootFs.resolveWithinRoot(rootId, relativePath, { expectKind: "directory" });
  assertNotInternal(resolved.relativePath);
  if (!resolved.exists) return { removed: false, reason: "ERR_PATH_NOT_FOUND" };
  const entries = await fs.readdir(resolved.absolutePath);
  if (entries.length > 0) return { removed: false, reason: "ERR_DIRECTORY_NOT_EMPTY" };
  await fs.rmdir(resolved.absolutePath);
  return { removed: true };
}

async function readManifest(absoluteEntry: string, entryPath: string): Promise<QuarantineManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPathFor(absoluteEntry), "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new QuarantineError(`Quarantine manifest missing for ${entryPath}`, "ERR_QUARANTINE_ENTRY_INVALID");
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as QuarantineManifest;
  if (parsed.schemaVersion !== 1 || typeof parsed.originalRelativePath !== "string") {
    throw new QuarantineError(`Quarantine manifest invalid for ${entryPath}`, "ERR_QUARANTINE_ENTRY_INVALID");
  }
  return parsed;
}

async function resolveEntry(rootId: string, entryPath: string) {
  let resolved;
  try {
    resolved = await defaultRootFs.resolveWithinRoot(rootId, `${QUARANTINE_DIR_NAME}/${entryPath}`, {
      mustExist: true,
      expectKind: "file",
    });
  } catch (err) {
    if (err instanceof RootFsError && err.code === "ERR_PATH_NOT_FOUND") {
      throw new QuarantineError(`Quarantine entry not found: ${entryPath}`, "ERR_QUARANTINE_ENTRY_NOT_FOUND");
    }
    throw err;
  }
  const manifest = await readManifest(resolved.absolutePath, entryPath);
  return { resolved, manifest };
}

export async function listQuarantine(rootId: string): Promise<QuarantineEntry[]> {
  const root = await defaultRootFs.canonicalRoot(rootId);
  const trashRoot = path.join(root, QUARANTINE_DIR_NAME);
  const entries: QuarantineEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (d.isFile() && d.name.endsWith(".manifest.json")) {
        const fileAbs = full.slice(0, -".manifest.json".length);
        const entryPath = path.relative(trashRoot, fileAbs).split(path.sep).join("/");
        try {
          const m = await readManifest(fileAbs, entryPath);
          entries.push({
            rootId,
            entryPath,
            originalRelativePath: m.originalRelativePath,
            planId: m.planId,
            quarantinedAt: m.quarantinedAt,
            expiresAt: m.expiresAt,
            sizeBytes: m.sizeBytes,
            nlink: m.nlink,
            reclaimableOnPurgeBytes: m.reclaimableOnPurgeBytes,
          });
        } catch {
          // Corrupt manifest: omitted from the listing; purge/restore refuse it explicitly.
        }
      }
    }
  }

  await walk(trashRoot);
  entries.sort((a, b) => a.quarantinedAt.localeCompare(b.quarantinedAt));
  return entries;
}

export interface RestoreResult {
  restoredRelativePath: string;
}

/** Restores a quarantined file to its original path. Never overwrites. */
export async function restoreQuarantined(rootId: string, entryPath: string): Promise<RestoreResult> {
  const { resolved, manifest } = await resolveEntry(rootId, entryPath);
  const destination = await defaultRootFs.resolveWithinRoot(rootId, manifest.originalRelativePath);
  if (destination.exists) {
    throw new QuarantineError(
      `Cannot restore ${entryPath}: ${manifest.originalRelativePath} now exists`,
      "ERR_RESTORE_TARGET_EXISTS"
    );
  }
  await fs.mkdir(path.dirname(destination.absolutePath), { recursive: true });
  await fs.rename(resolved.absolutePath, destination.absolutePath);
  await fs.rm(manifestPathFor(resolved.absolutePath), { force: true });
  return { restoredRelativePath: manifest.originalRelativePath };
}

export interface PurgeResult {
  freedBytes: number;
}

/** Permanently deletes a quarantined file. Only reachable through an approved purge plan. */
export async function purgeQuarantined(rootId: string, entryPath: string): Promise<PurgeResult> {
  const { resolved, manifest } = await resolveEntry(rootId, entryPath);
  const identity = await defaultRootFs.getFileIdentity(resolved.absolutePath);
  const freed = reclaimableBytes(identity.sizeBytes ?? manifest.sizeBytes, identity.nlink ?? manifest.nlink);
  await fs.unlink(resolved.absolutePath);
  await fs.rm(manifestPathFor(resolved.absolutePath), { force: true });
  return { freedBytes: freed };
}

export { RootFsError };
