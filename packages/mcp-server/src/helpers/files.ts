import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";
import { resolveSafePath } from "./sandbox.js";

export const execFileAsync = promisify(execFile);

export const VIDEO_EXT = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts"]);
export const ARCHIVE_EXT = new Set([".rar", ".zip", ".7z"]);

export async function moveFile(src: string, dest: string) {
  try { await fs.rename(src, dest); } catch (e: any) {
    if (e.code === "EXDEV") { await fs.copyFile(src, dest); await fs.unlink(src); } else throw e;
  }
}

export function isVideoFile(f: string) { return VIDEO_EXT.has(path.extname(f).toLowerCase()); }
export function isArchiveFile(f: string) { return ARCHIVE_EXT.has(path.extname(f).toLowerCase()); }

export function extractEpisodeNumber(filename: string): number {
  // Try common patterns: S01E05, 1x05, E05, etc.
  // We prioritize patterns that are less likely to be part of a year or resolution
  for (const p of [
    /[Ss]\d+[Ee](\d+)/,           // S01E05
    /(\d+)x(\d+)/,                // 1x05
    /[Ee][Pp](\d+)/,              // EP05
    /[_ \-][Ee](\d+)[_ \-]/,      // - E05 -
    /[_ \-](\d+)[_ \-]/,          // - 05 -
    /^[ \[]*(\d+)[ \]]*[_ \-]/,   // [05] - or 05 - at start
    / (\d+) /,                    // " 05 "
  ]) {
    const m = filename.match(p);
    if (m) {
      const n = parseInt(m[m.length === 3 ? 2 : 1]);
      if (!isNaN(n) && n >= 0 && n < 2000) return n;
    }
  }
  return 9999;
}

export async function extractArchive(archivePath: string, destDir: string, password?: string): Promise<string[]> {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === ".rar") { const a = ["x", "-o+", archivePath, destDir]; if (password) a.splice(1, 0, `-p${password}`); await execFileAsync("unrar", a, { timeout: 300_000 }); }
  else if (ext === ".zip") { const a = ["-o", archivePath, "-d", destDir]; if (password) a.splice(0, 0, `-P${password}`); await execFileAsync("unzip", a, { timeout: 300_000 }); }
  else if (ext === ".7z") { const a = ["x", `-o${destDir}`, "-y", archivePath]; if (password) a.splice(1, 0, `-p${password}`); await execFileAsync("7z", a, { timeout: 300_000 }); }
  const videos: string[] = [];
  async function walk(dir: string) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) await walk(f); else if (isVideoFile(e.name)) videos.push(f); } }
  await walk(destDir);
  return videos;
}

export async function detectAndFixExtension(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && (VIDEO_EXT.has(ext) || ARCHIVE_EXT.has(ext))) return filePath;
  const fd = await fs.open(filePath, "r");
  const buf = Buffer.alloc(12);
  await fd.read(buf, 0, 12, 0);
  await fd.close();
  const hex = buf.toString("hex").toUpperCase();
  let newExt = "";
  if (hex.startsWith("526172")) newExt = ".rar";
  else if (hex.startsWith("504B0304")) newExt = ".zip";
  else if (hex.startsWith("377ABCAF")) newExt = ".7z";
  else if (hex.startsWith("1A45DFA3")) newExt = ".mkv";
  else if (hex.slice(8, 16) === "66747970") newExt = ".mp4";
  if (newExt) { const np = filePath + newExt; await fs.rename(filePath, np); return np; }
  return filePath;
}

/**
 * Resolves a user-supplied path under MEDIA_PATH or DOWNLOADS_PATH and
 * GUARANTEES the result remains inside one of those roots — throws
 * PathSandboxError otherwise. Thin wrapper over resolveSafePath() that
 * keeps the legacy `resolvePath(string): string` shape callers depend on.
 */
export function resolvePath(p: string): string {
  return resolveSafePath(p, { media: MEDIA_PATH, downloads: DOWNLOADS_PATH }).full;
}
