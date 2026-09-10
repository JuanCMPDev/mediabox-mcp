import { execFileAsync } from "../helpers/files.js";
import { defaultRootFs } from "./rootfs.js";
import * as path from "node:path";
import fs from "node:fs/promises";
import { resolveNamespacePath } from "./namespace-map.js";

export interface MediaFormatProfile {
  action: "remux" | "transcode" | "subtitle-convert";
  profileName: string;
}

export async function inspectMedia(logicalPath: string) {
  const absolutePath = await resolveNamespacePath(logicalPath);
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      absolutePath,
    ]);
    return JSON.parse(stdout);
  } catch (err: any) {
    throw new Error(`Failed to inspect media ${logicalPath}: ${err.message}`);
  }
}

export async function executeMediaJob(logicalPath: string, profile: MediaFormatProfile, abortSignal?: AbortSignal) {
  const absolutePath = await resolveNamespacePath(logicalPath);
  const rootId = logicalPath.startsWith("downloads/") ? "downloads" : "media"; // basic logic, relying on mapNamespace
  const rootDir = defaultRootFs.getRootPath(rootId);
  
  const stagingDir = path.join(rootDir, ".mediabox-staging");
  await fs.mkdir(stagingDir, { recursive: true });

  const safeName = `${Date.now()}-${path.basename(absolutePath)}`;
  const stagingPath = path.join(stagingDir, safeName);

  let args: string[] = [];

  if (profile.action === "remux") {
    // -c copy is remux
    args = ["-y", "-i", absolutePath, "-c", "copy", stagingPath];
  } else if (profile.action === "subtitle-convert") {
    // Convert ASS to SRT
    args = ["-y", "-i", absolutePath, "-c:v", "copy", "-c:a", "copy", "-c:s", "srt", stagingPath];
  } else if (profile.action === "transcode" && profile.profileName === "cpu_av1_transcode") {
    // Generic CPU AV1 Transcode
    args = ["-y", "-i", absolutePath, "-c:v", "libsvtav1", "-crf", "30", "-preset", "6", "-c:a", "libopus", "-b:a", "128k", stagingPath];
  } else if (profile.action === "transcode" && profile.profileName === "cpu_hevc_transcode") {
    // Generic CPU HEVC Transcode
    args = ["-y", "-i", absolutePath, "-c:v", "libx265", "-crf", "28", "-preset", "fast", "-c:a", "copy", stagingPath];
  } else {
    throw new Error(`Unsupported media profile: ${profile.action} / ${profile.profileName}`);
  }

  try {
    await execFileAsync("ffmpeg", args, { signal: abortSignal });
    
    // Validate output with ffprobe
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", stagingPath
    ]);
    if (!stdout || parseFloat(stdout) <= 0) {
      throw new Error("ffprobe validation failed: zero duration output");
    }

    // Recoverable Replacement
    const backupPath = `${absolutePath}.backup-${Date.now()}`;
    await fs.rename(absolutePath, backupPath);
    await fs.rename(stagingPath, absolutePath);
    
    // Wait, the document says "No unlink(original) antes de disponer de un resultado validado y una recuperación. Mantener backup según plan"
    // The plan should specify if backup should be deleted or kept, for now we keep it or we can delete it based on TTL.
    // The executor can clean up the backup if it's successful.

    return {
      success: true,
      stagingPath,
      backupPath,
    };
  } catch (err: any) {
    // Cleanup staging if failed
    await fs.rm(stagingPath, { force: true }).catch(() => {});
    throw err;
  }
}
