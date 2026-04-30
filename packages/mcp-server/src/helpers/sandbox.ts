import path from "node:path";

export type SandboxRoot = "media" | "downloads";

export class PathSandboxError extends Error {
  constructor(public readonly attempted: string, public readonly root: SandboxRoot) {
    super(`Path "${attempted}" escapes ${root} sandbox`);
    this.name = "PathSandboxError";
  }
}

export interface SandboxRoots {
  media: string;
  downloads: string;
}

export interface SafePathResult {
  full: string;
  root: SandboxRoot;
}

/**
 * Resolves a user-supplied path under MEDIA or DOWNLOADS and guarantees the
 * result remains inside one of those roots. Replaces the pre-2.2 resolvePath()
 * which used path.join() and was traversal-vulnerable (e.g. "../etc/passwd"
 * would escape MEDIA_PATH because path.join collapses ".." segments).
 *
 * Accepted inputs:
 *   "anime/Show"           → <media>/anime/Show
 *   "/data/anime/Show"     → <media>/anime/Show     (absolute, under media root)
 *   "downloads/foo"        → <downloads>/foo
 *   "/downloads/foo"       → <downloads>/foo        (absolute, under downloads root)
 *
 * Rejected (throws PathSandboxError):
 *   "../etc/passwd", "anime/../../etc", "/etc/passwd", "" or non-string.
 */
export function resolveSafePath(input: string, roots: SandboxRoots): SafePathResult {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathSandboxError(String(input), "media");
  }
  if (input.includes("\0")) {
    throw new PathSandboxError(input, "media");
  }

  const mediaRoot = path.resolve(roots.media);
  const downloadsRoot = path.resolve(roots.downloads);

  let candidateRoot: string;
  let rootName: SandboxRoot;
  let rel: string;

  if (input === "downloads" || input.startsWith("downloads/")) {
    candidateRoot = downloadsRoot;
    rootName = "downloads";
    rel = input.replace(/^downloads\/?/, "");
  } else if (path.isAbsolute(input)) {
    const abs = path.resolve(input);
    if (abs === downloadsRoot || abs.startsWith(downloadsRoot + path.sep)) {
      candidateRoot = downloadsRoot;
      rootName = "downloads";
      rel = path.relative(downloadsRoot, abs);
    } else if (abs === mediaRoot || abs.startsWith(mediaRoot + path.sep)) {
      candidateRoot = mediaRoot;
      rootName = "media";
      rel = path.relative(mediaRoot, abs);
    } else {
      throw new PathSandboxError(input, "media");
    }
  } else {
    candidateRoot = mediaRoot;
    rootName = "media";
    rel = input;
  }

  const full = path.resolve(candidateRoot, rel);
  if (full !== candidateRoot && !full.startsWith(candidateRoot + path.sep)) {
    throw new PathSandboxError(input, rootName);
  }

  return { full, root: rootName };
}

/**
 * Validates a single path segment (file or folder name) — rejects separators,
 * "..", control chars, and empty strings. Use this to guard user-supplied
 * names like showName / packageFolder before composing paths from them.
 */
export function assertSafeSegment(s: string): string {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error(`Unsafe path segment: "${s}"`);
  }
  if (s.includes("/") || s.includes("\\") || s === "." || s === "..") {
    throw new Error(`Unsafe path segment: "${s}"`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(s)) {
    throw new Error(`Unsafe path segment: "${s}"`);
  }
  return s;
}
