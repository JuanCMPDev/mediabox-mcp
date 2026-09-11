import * as path from "node:path";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";
import { defaultRootFs, RootFsError, type ResolvedPath, type ResolveOptions } from "./rootfs.js";

/**
 * Namespace mapping (Blueprint 4.3): translates logical paths and container
 * paths reported by services ("/tv/Show", "/data/movies/...", "/downloads/x")
 * into { rootId, relativePath } before any disk access. A path that does not
 * belong to a registered mount produces PATH_MAPPING_UNKNOWN; it is never
 * interpreted as a missing file.
 */

export class PathMappingUnknownError extends Error {
  readonly code = "PATH_MAPPING_UNKNOWN";
  constructor(message: string) {
    super(message);
    this.name = "PathMappingUnknownError";
  }
}

export interface NamespaceMapping {
  rootId: string;
  relativePath: string;
}

export interface MountMapping {
  /** Container/service path prefix, e.g. "/tv". */
  prefix: string;
  rootId: string;
  /** Sub-directory under the root that the prefix corresponds to ("" for the root). */
  subdir: string;
}

const DEFAULT_MOUNTS: MountMapping[] = [
  { prefix: "/downloads", rootId: "downloads", subdir: "" },
  { prefix: "/data", rootId: "media", subdir: "" },
  { prefix: "/tv", rootId: "media", subdir: "tv" },
  { prefix: "/movies", rootId: "media", subdir: "movies" },
  { prefix: "/anime", rootId: "media", subdir: "anime" },
  { prefix: "/music", rootId: "media", subdir: "music" },
];

let mounts: MountMapping[] = [...DEFAULT_MOUNTS];

export function registerMount(mount: MountMapping): void {
  mounts = [...mounts.filter((m) => m.prefix !== mount.prefix), mount];
}

export function resetMountsForTesting(): void {
  mounts = [...DEFAULT_MOUNTS];
}

export function registerDefaultRoots(): void {
  defaultRootFs.registerRoot("media", MEDIA_PATH);
  defaultRootFs.registerRoot("downloads", DOWNLOADS_PATH);
}

registerDefaultRoots();

function joinLogical(subdir: string, rest: string): string {
  return [subdir, rest].filter((p) => p.length > 0).join("/");
}

const NUL_CHAR = String.fromCharCode(0);

export function mapNamespace(logicalPath: string): NamespaceMapping {
  if (typeof logicalPath !== "string" || logicalPath.includes(NUL_CHAR)) {
    throw new PathMappingUnknownError("Path must be a string without NUL characters");
  }
  const unified = logicalPath.replace(/\\/g, "/").trim();
  if (unified.length === 0 || unified === "." || unified === "/") {
    throw new PathMappingUnknownError("Empty path cannot be mapped to a root");
  }

  // Container-style absolute paths ("/tv/Show", "/data/movies/X", "/downloads/Y").
  if (unified.startsWith("/") && !unified.startsWith("//")) {
    const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);
    for (const m of sorted) {
      if (unified === m.prefix) {
        return { rootId: m.rootId, relativePath: m.subdir };
      }
      if (unified.startsWith(m.prefix + "/")) {
        return { rootId: m.rootId, relativePath: joinLogical(m.subdir, unified.slice(m.prefix.length + 1)) };
      }
    }
    throw new PathMappingUnknownError(`No mount registered for container path: ${logicalPath}`);
  }

  // Host absolute paths (drive letters / UNC) are only accepted when they live
  // under a registered root of this process.
  if (/^[A-Za-z]:/.test(unified) || unified.startsWith("//")) {
    const abs = path.resolve(logicalPath);
    for (const { rootId, path: rootPath } of defaultRootFs.listRoots()) {
      const rel = path.relative(rootPath, abs);
      if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return { rootId, relativePath: rel.split(path.sep).join("/") };
      }
    }
    throw new PathMappingUnknownError(`Host path is outside every registered root: ${logicalPath}`);
  }

  if (unified === "downloads" || unified.startsWith("downloads/")) {
    return { rootId: "downloads", relativePath: unified === "downloads" ? "" : unified.slice("downloads/".length) };
  }

  return { rootId: "media", relativePath: unified };
}

export async function resolveNamespacePath(logicalPath: string, opts: ResolveOptions = {}): Promise<ResolvedPath> {
  const { rootId, relativePath } = mapNamespace(logicalPath);
  return defaultRootFs.resolveWithinRoot(rootId, relativePath, opts);
}

export { RootFsError };
