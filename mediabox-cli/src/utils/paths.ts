import path from "node:path";

/**
 * Normalize a path to POSIX format (forward slashes).
 * Docker Compose requires forward slashes even on Windows.
 */
export function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

/**
 * Ensure a relative path starts with "./"
 */
export function ensureRelative(p: string): string {
  const posix = toPosix(p);
  if (posix.startsWith("./") || posix.startsWith("../") || path.isAbsolute(p)) {
    return posix;
  }
  return `./${posix}`;
}
