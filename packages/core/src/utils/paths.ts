import path from "node:path";

/**
 * Normalize a path to POSIX format (forward slashes).
 * Docker Compose requires forward slashes even on Windows.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Ensure a relative path starts with "./"
 * Absolute paths and paths that already start with "./" or "../" are left alone.
 */
export function ensureRelative(p: string): string {
  const posix = toPosix(p);
  if (posix.startsWith("./") || posix.startsWith("../") || path.isAbsolute(p)) {
    return posix;
  }
  return `./${posix}`;
}
