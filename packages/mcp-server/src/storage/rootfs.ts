import { lstat, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { PlannedTargetFileIdentity } from "@mediabox/contracts";

/**
 * RootFs: registered roots and confined path resolution (Blueprint 4.3).
 *
 * Guarantees enforced here, independently of string prefixes:
 *  - a root is canonicalised with the native realpath (8.3 names, case,
 *    junction-backed roots) before any comparison;
 *  - every existing component under the root is lstat-ed and rejected when it
 *    is a symbolic link or junction (no link is ever followed);
 *  - the final realpath must be strictly inside the canonical root, compared
 *    with path.relative, never with startsWith;
 *  - operating on the root itself, on absolute paths, on "..", on device names
 *    or on filesystem roots is refused.
 *
 * realpath followed by a string operation cannot exclude TOCTOU races; the
 * executor therefore re-verifies file identity immediately before each effect
 * (see assertIdentity).
 */

export type RootFsErrorCode =
  | "ERR_ROOT_NOT_REGISTERED"
  | "ERR_ROOT_INVALID"
  | "ERR_PATH_INVALID"
  | "ERR_PATH_IS_ROOT"
  | "ERR_PATH_IS_LINK"
  | "ERR_PATH_ESCAPES_ROOT"
  | "ERR_PATH_NOT_FOUND"
  | "ERR_NOT_REGULAR_FILE"
  | "ERR_NOT_DIRECTORY"
  | "ERR_IDENTITY_MISMATCH";

export class RootFsError extends Error {
  constructor(message: string, public readonly code: RootFsErrorCode) {
    super(message);
    this.name = "RootFsError";
  }
}

export type PathKind = "file" | "directory" | "other";

export interface ResolvedPath {
  rootId: string;
  canonicalRoot: string;
  /** Normalised relative path using "/" separators. */
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  kind?: PathKind;
}

export interface ResolveOptions {
  mustExist?: boolean;
  expectKind?: "file" | "directory";
}

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/;

/**
 * Splits a logical relative path into validated segments.
 * Rejects absolute paths (POSIX, drive letters, UNC), "." and ".." segments,
 * control characters and Windows device names. Returns at least one segment.
 */
export function normalizeRelativePath(input: string): string[] {
  if (typeof input !== "string") {
    throw new RootFsError("Relative path must be a string", "ERR_PATH_INVALID");
  }
  if (input.includes("\0")) {
    throw new RootFsError("Relative path contains NUL", "ERR_PATH_INVALID");
  }
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw new RootFsError(`Absolute paths are not accepted as relative targets: ${input}`, "ERR_PATH_INVALID");
  }
  const segments = unified.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new RootFsError("Operating on a root itself is not allowed", "ERR_PATH_IS_ROOT");
  }
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new RootFsError(`Path traversal segment not allowed: ${input}`, "ERR_PATH_INVALID");
    }
    if (CONTROL_CHARS.test(seg)) {
      throw new RootFsError("Path contains control characters", "ERR_PATH_INVALID");
    }
    if (RESERVED_WINDOWS_NAMES.test(seg)) {
      throw new RootFsError(`Reserved device name not allowed: ${seg}`, "ERR_PATH_INVALID");
    }
  }
  return segments;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

type Stats = Awaited<ReturnType<typeof lstat>>;

export class RootFs {
  private roots = new Map<string, { configured: string; canonical?: string }>();

  registerRoot(rootId: string, absolutePath: string): void {
    if (typeof absolutePath !== "string" || absolutePath.length === 0) {
      throw new RootFsError(`Root ${rootId} needs a path`, "ERR_ROOT_INVALID");
    }
    const resolved = path.resolve(absolutePath);
    const parsed = path.parse(resolved);
    if (parsed.root === resolved) {
      throw new RootFsError(`Root ${rootId} cannot be a filesystem root: ${resolved}`, "ERR_ROOT_INVALID");
    }
    this.roots.set(rootId, { configured: resolved });
  }

  isRegistered(rootId: string): boolean {
    return this.roots.has(rootId);
  }

  listRoots(): Array<{ rootId: string; path: string }> {
    return [...this.roots.entries()].map(([rootId, r]) => ({ rootId, path: r.configured }));
  }

  /** Configured (non-canonical) root path. Prefer canonicalRoot for comparisons. */
  getRootPath(rootId: string): string {
    const entry = this.roots.get(rootId);
    if (!entry) throw new RootFsError(`Root not registered: ${rootId}`, "ERR_ROOT_NOT_REGISTERED");
    return entry.configured;
  }

  async canonicalRoot(rootId: string): Promise<string> {
    const entry = this.roots.get(rootId);
    if (!entry) throw new RootFsError(`Root not registered: ${rootId}`, "ERR_ROOT_NOT_REGISTERED");
    if (entry.canonical) return entry.canonical;
    let canonical: string;
    try {
      canonical = await realpath(entry.configured);
    } catch (err: any) {
      throw new RootFsError(`Root ${rootId} is not accessible: ${entry.configured} (${err?.code ?? err})`, "ERR_ROOT_INVALID");
    }
    const st = await stat(canonical).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new RootFsError(`Root ${rootId} is not a directory: ${entry.configured}`, "ERR_ROOT_INVALID");
    }
    entry.canonical = canonical;
    return canonical;
  }

  /**
   * Resolves relativePath under rootId, walking component by component.
   * Existing components are lstat-ed; links and junctions are refused.
   */
  async resolveWithinRoot(rootId: string, relativePath: string, opts: ResolveOptions = {}): Promise<ResolvedPath> {
    const segments = normalizeRelativePath(relativePath);
    const root = await this.canonicalRoot(rootId);

    let current = root;
    let exists = true;
    let finalStat: Stats | undefined;

    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      let st: Stats;
      try {
        st = await lstat(current);
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
          exists = false;
          break;
        }
        throw err;
      }
      if (st.isSymbolicLink()) {
        throw new RootFsError(`Links are not allowed inside a root: ${segments.slice(0, i + 1).join("/")}`, "ERR_PATH_IS_LINK");
      }
      if (i < segments.length - 1 && !st.isDirectory()) {
        throw new RootFsError(`Intermediate component is not a directory: ${segments.slice(0, i + 1).join("/")}`, "ERR_NOT_DIRECTORY");
      }
      finalStat = st;
    }

    const absolutePath = path.join(root, ...segments);

    if (exists) {
      const real = await realpath(absolutePath);
      if (!isInside(root, real)) {
        throw new RootFsError(`Path escapes root ${rootId}: ${relativePath}`, "ERR_PATH_ESCAPES_ROOT");
      }
    } else if (!isInside(root, absolutePath)) {
      throw new RootFsError(`Path escapes root ${rootId}: ${relativePath}`, "ERR_PATH_ESCAPES_ROOT");
    }

    if (opts.mustExist && !exists) {
      throw new RootFsError(`Path not found under ${rootId}: ${relativePath}`, "ERR_PATH_NOT_FOUND");
    }

    let kind: PathKind | undefined;
    if (exists && finalStat) {
      kind = finalStat.isFile() ? "file" : finalStat.isDirectory() ? "directory" : "other";
    }
    if (exists && opts.expectKind === "file" && kind !== "file") {
      throw new RootFsError(`Not a regular file: ${relativePath}`, "ERR_NOT_REGULAR_FILE");
    }
    if (exists && opts.expectKind === "directory" && kind !== "directory") {
      throw new RootFsError(`Not a directory: ${relativePath}`, "ERR_NOT_DIRECTORY");
    }

    return {
      rootId,
      canonicalRoot: root,
      relativePath: segments.join("/"),
      absolutePath,
      exists,
      kind,
    };
  }

  async getFileIdentity(absolutePath: string): Promise<PlannedTargetFileIdentity> {
    const s = await stat(absolutePath);
    return {
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
      inode: s.ino || undefined,
      nlink: s.nlink,
      kind: s.isFile() ? "file" : s.isDirectory() ? "directory" : undefined,
    };
  }

  async computeSha256(absolutePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = createReadStream(absolutePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  /** Returns a human-readable mismatch reason, or null when the identity matches. */
  async identityMismatch(absolutePath: string, expected: PlannedTargetFileIdentity): Promise<string | null> {
    let current: PlannedTargetFileIdentity;
    try {
      current = await this.getFileIdentity(absolutePath);
    } catch (err: any) {
      if (err?.code === "ENOENT") return "target no longer exists";
      throw err;
    }
    if (expected.kind && current.kind !== expected.kind) return `kind changed (${expected.kind} -> ${current.kind})`;
    if (expected.sizeBytes !== undefined && current.sizeBytes !== expected.sizeBytes) return `size changed (${expected.sizeBytes} -> ${current.sizeBytes})`;
    if (expected.mtimeMs !== undefined && current.mtimeMs !== expected.mtimeMs) return "mtime changed";
    if (expected.inode && current.inode && current.inode !== expected.inode) return "inode changed";
    if (expected.sha256) {
      const currentHash = await this.computeSha256(absolutePath);
      if (currentHash !== expected.sha256) return "content hash changed";
    }
    return null;
  }

  async verifyIdentity(absolutePath: string, expected: PlannedTargetFileIdentity): Promise<boolean> {
    return (await this.identityMismatch(absolutePath, expected)) === null;
  }

  async assertIdentity(absolutePath: string, expected: PlannedTargetFileIdentity): Promise<void> {
    const reason = await this.identityMismatch(absolutePath, expected);
    if (reason) {
      throw new RootFsError(`Target identity changed since the plan was created: ${reason}`, "ERR_IDENTITY_MISMATCH");
    }
  }

  resetForTesting(): void {
    this.roots.clear();
  }
}

export const defaultRootFs = new RootFs();
