#!/usr/bin/env node
/**
 * Gate G05 Smoke: Real FFmpeg, ffprobe and media job recovery (§4.3 / MED-01..MED-06 / P05).
 * Validates real media transformations and trash isolation against real binaries.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRootFs } from "../../packages/mcp-server/dist/storage/rootfs.js";
import {
  MEDIA_PROFILES,
  executeMediaJob,
  probeFile,
} from "../../packages/mcp-server/dist/storage/media-jobs.js";
import { QUARANTINE_DIR_NAME, STAGING_DIR_NAME } from "../../packages/mcp-server/dist/storage/quarantine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("=== Gate G05: Validating Real FFmpeg & Media Job Recovery ===");

// ── 1. Check prerequisites (ffmpeg, ffprobe, libx265) ─────────────────────────
console.log("1. Checking ffmpeg, ffprobe and libx265 support...");
try {
  execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  const encoders = execFileSync("ffmpeg", ["-encoders"], { encoding: "utf8" });
  if (!encoders.includes("libx265")) {
    console.error("FAIL: ffmpeg does not support libx265 encoder");
    process.exit(1);
  }
} catch (err) {
  console.error("FAIL: ffmpeg or ffprobe not found or execution failed:", err.message);
  process.exit(1);
}
console.log("✓ FFmpeg, FFprobe, and libx265 verified.");

// ── 2. Setup temporary media root ─────────────────────────────────────────────
const base = await fs.mkdtemp(path.join(os.tmpdir(), "mbx-smoke-ffmpeg-"));
const root = path.join(base, "media");
await fs.mkdir(root, { recursive: true });
defaultRootFs.resetForTesting();
defaultRootFs.registerRoot("media", root);

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

try {
  const moviesDir = path.join(root, "movies");
  await fs.mkdir(moviesDir, { recursive: true });

  // ── 3. Test 1: mkv_remux (MP4 -> MKV without re-encoding) ───────────────────
  console.log("2. Testing real mkv_remux on MP4 fixture...");
  const remuxInput = path.join(moviesDir, "fixture_remux.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=128x72:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264",
    "-c:a", "aac",
    "-shortest",
    remuxInput,
  ], { stdio: "ignore" });

  const remuxRes = await executeMediaJob(
    { rootId: "media", relativePath: "movies/fixture_remux.mp4" },
    MEDIA_PROFILES.mkv_remux,
    { planId: "plan_smoke_remux" }
  );

  const publishedRemux = path.join(root, remuxRes.outputRelativePath);
  const backupRemux = path.join(root, QUARANTINE_DIR_NAME, remuxRes.backupEntryPath);

  if (!(await exists(publishedRemux))) {
    throw new Error(`Published remux output missing: ${publishedRemux}`);
  }
  if (await exists(remuxInput)) {
    throw new Error(`Original input file still exists at source path: ${remuxInput}`);
  }
  if (!(await exists(backupRemux))) {
    throw new Error(`Quarantined backup missing: ${backupRemux}`);
  }

  const probeRemux = await probeFile(publishedRemux);
  const vStream = probeRemux.streams.find((s) => s.type === "video");
  const aStream = probeRemux.streams.find((s) => s.type === "audio");
  if (vStream?.codec !== "h264" || aStream?.codec !== "aac") {
    throw new Error(`Unexpected remux codecs: video=${vStream?.codec}, audio=${aStream?.codec}`);
  }
  console.log("✓ mkv_remux verified with real media & quarantine preservation.");

  // ── 4. Test 2: srt_subtitles (Convert subtitle tracks to SubRip/SRT) ────────
  console.log("3. Testing real srt_subtitles conversion...");
  const baseMp4 = path.join(moviesDir, "temp_base.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=128x72:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264",
    "-c:a", "aac",
    "-shortest",
    baseMp4,
  ], { stdio: "ignore" });

  const srtFile = path.join(moviesDir, "temp.srt");
  await fs.writeFile(srtFile, "1\n00:00:00,000 --> 00:00:02,000\nSmoke test subtitle\n\n", "utf8");

  const subInput = path.join(moviesDir, "fixture_sub.mkv");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i", baseMp4,
    "-i", srtFile,
    "-map", "0:v",
    "-map", "0:a",
    "-map", "1:s",
    "-c:v", "copy",
    "-c:a", "copy",
    "-c:s", "ass",
    subInput,
  ], { stdio: "ignore" });
  await fs.rm(baseMp4, { force: true });
  await fs.rm(srtFile, { force: true });

  const subRes = await executeMediaJob(
    { rootId: "media", relativePath: "movies/fixture_sub.mkv" },
    MEDIA_PROFILES.srt_subtitles,
    { planId: "plan_smoke_sub" }
  );

  const publishedSub = path.join(root, subRes.outputRelativePath);
  const backupSub = path.join(root, QUARANTINE_DIR_NAME, subRes.backupEntryPath);

  if (!(await exists(publishedSub))) {
    throw new Error(`Published subtitle output missing: ${publishedSub}`);
  }
  if (!(await exists(backupSub))) {
    throw new Error(`Quarantined subtitle backup missing: ${backupSub}`);
  }

  const probeSub = await probeFile(publishedSub);
  const sStream = probeSub.streams.find((s) => s.type === "subtitle");
  if (sStream?.codec !== "subrip") {
    throw new Error(`Subtitle codec was not converted to subrip, found: ${sStream?.codec}`);
  }
  console.log("✓ srt_subtitles verified with real media & quarantine preservation.");

  // ── 5. Test 3: cpu_hevc_transcode (Re-encode video to HEVC / libx265) ────────
  console.log("4. Testing real cpu_hevc_transcode with libx265...");
  const hevcInput = path.join(moviesDir, "fixture_hevc.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=128x72:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264",
    "-c:a", "aac",
    "-shortest",
    hevcInput,
  ], { stdio: "ignore" });

  const hevcRes = await executeMediaJob(
    { rootId: "media", relativePath: "movies/fixture_hevc.mp4" },
    MEDIA_PROFILES.cpu_hevc_transcode,
    { planId: "plan_smoke_hevc" }
  );

  const publishedHevc = path.join(root, hevcRes.outputRelativePath);
  const backupHevc = path.join(root, QUARANTINE_DIR_NAME, hevcRes.backupEntryPath);

  if (!(await exists(publishedHevc))) {
    throw new Error(`Published HEVC output missing: ${publishedHevc}`);
  }
  if (await exists(hevcInput)) {
    throw new Error(`Original input file still exists: ${hevcInput}`);
  }
  if (!(await exists(backupHevc))) {
    throw new Error(`Quarantined backup missing: ${backupHevc}`);
  }

  const probeHevc = await probeFile(publishedHevc);
  const vHevc = probeHevc.streams.find((s) => s.type === "video");
  if (vHevc?.codec !== "hevc") {
    throw new Error(`Transcoded video codec is not hevc, found: ${vHevc?.codec}`);
  }
  console.log("✓ cpu_hevc_transcode verified with libx265 & quarantine preservation.");

  console.log("✓ Gate G05 PASSED: Real FFmpeg and media job recovery verified.");
  process.exit(0);
} catch (err) {
  console.error("FAIL: Gate G05 smoke error:", err);
  process.exit(1);
} finally {
  defaultRootFs.resetForTesting();
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
}
