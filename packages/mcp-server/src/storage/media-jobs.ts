import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { PlannedTargetFileIdentity } from "@mediabox/contracts";
import { defaultRootFs } from "./rootfs.js";
import { quarantineFile, restoreQuarantined, STAGING_DIR_NAME } from "./quarantine.js";

/**
 * Media jobs (Blueprint 4.3 / P05): inspect, remux, subtitle-convert and
 * transcode are separate actions with closed profiles. FFmpeg arguments are
 * produced by the profile table, never by the model. A job writes to an
 * exclusive staging file on the same volume, validates the output with ffprobe
 * against the profile (tracks, codecs, duration), moves the original into the
 * plan's quarantine entry and only then publishes the output at the original
 * path. The original is never unlinked; a failed publish restores it.
 */

const execFileAsync = promisify(execFile);

export type MediaAction = "remux" | "subtitle-convert" | "transcode";

export type MediaJobErrorCode =
  | "ERR_UNSUPPORTED_PROFILE"
  | "ERR_INSUFFICIENT_SPACE"
  | "ERR_PROBE_FAILED"
  | "ERR_FFMPEG_FAILED"
  | "ERR_OUTPUT_INVALID"
  | "ERR_CANCELLED"
  | "ERR_REPLACE_FAILED";

export class MediaJobError extends Error {
  constructor(message: string, public readonly code: MediaJobErrorCode, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "MediaJobError";
  }
}

export interface ProbeStream {
  index: number;
  type: string;
  codec: string;
  language?: string;
  title?: string;
  isDefault?: boolean;
  width?: number;
  height?: number;
  channels?: number;
}

export interface ProbeSummary {
  formatName?: string;
  durationSec: number;
  sizeBytes?: number;
  streams: ProbeStream[];
}

export interface CommandRunnerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
}

export type CommandRunner = (
  file: "ffmpeg" | "ffprobe",
  args: string[],
  opts: CommandRunnerOptions
) => Promise<{ stdout: string; stderr: string }>;

export const execCommandRunner: CommandRunner = async (file, args, opts) => {
  const res = await execFileAsync(file, args, {
    signal: opts.signal,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
};

let activeRunner: CommandRunner = execCommandRunner;

/** Runner used when a job does not receive an explicit one (handlers, tools). */
export const defaultCommandRunner: CommandRunner = (file, args, opts) => activeRunner(file, args, opts);

/** Test seam: replaces the process-wide runner (ffmpeg/ffprobe) used by handlers and tools. */
export function setDefaultCommandRunner(runner: CommandRunner | null): void {
  activeRunner = runner ?? execCommandRunner;
}

export interface MediaProfile {
  name: string;
  action: MediaAction;
  description: string;
  /** True when information is discarded (re-encoding, styled subtitles flattened). */
  irreversible: boolean;
  outputExtension: string;
  /** Multiplier over the input size reserved on the volume before running. */
  stagingFactor: number;
  ffmpegArgs(input: string, output: string): string[];
  /** Returns a list of violations; empty means the output conforms to the profile. */
  validate(input: ProbeSummary, output: ProbeSummary): string[];
}

const DURATION_TOLERANCE_RATIO = 0.01;
const DURATION_TOLERANCE_SEC = 2;

function durationConforms(input: ProbeSummary, output: ProbeSummary): string[] {
  const tolerance = Math.max(DURATION_TOLERANCE_SEC, input.durationSec * DURATION_TOLERANCE_RATIO);
  if (Math.abs(input.durationSec - output.durationSec) > tolerance) {
    return [`duration ${output.durationSec.toFixed(2)}s deviates from input ${input.durationSec.toFixed(2)}s`];
  }
  return [];
}

function streamsOf(p: ProbeSummary, type: string): ProbeStream[] {
  return p.streams.filter((s) => s.type === type);
}

function sameCount(input: ProbeSummary, output: ProbeSummary, type: string): string[] {
  const a = streamsOf(input, type).length;
  const b = streamsOf(output, type).length;
  return a === b ? [] : [`${type} stream count changed (${a} -> ${b})`];
}

function sameCodecs(input: ProbeSummary, output: ProbeSummary, type: string): string[] {
  const a = streamsOf(input, type).map((s) => s.codec);
  const b = streamsOf(output, type).map((s) => s.codec);
  if (a.length !== b.length) return [`${type} stream count changed (${a.length} -> ${b.length})`];
  const v: string[] = [];
  a.forEach((codec, i) => {
    if (codec !== b[i]) v.push(`${type} stream ${i} codec changed (${codec} -> ${b[i]})`);
  });
  return v;
}

function allCodecs(output: ProbeSummary, type: string, expected: string[]): string[] {
  return streamsOf(output, type)
    .filter((s) => !expected.includes(s.codec))
    .map((s) => `${type} stream ${s.index} codec ${s.codec} not in ${expected.join("/")}`);
}

const COMMON_PREFIX = ["-hide_banner", "-nostdin", "-y"];

export const MEDIA_PROFILES: Record<string, MediaProfile> = {
  mkv_remux: {
    name: "mkv_remux",
    action: "remux",
    description: "Copy every stream into a Matroska container without re-encoding (-c copy).",
    irreversible: false,
    outputExtension: ".mkv",
    stagingFactor: 1.05,
    ffmpegArgs: (input, output) => [...COMMON_PREFIX, "-i", input, "-map", "0", "-c", "copy", output],
    validate: (input, output) => [
      ...sameCodecs(input, output, "video"),
      ...sameCodecs(input, output, "audio"),
      ...sameCount(input, output, "subtitle"),
      ...durationConforms(input, output),
    ],
  },
  srt_subtitles: {
    name: "srt_subtitles",
    action: "subtitle-convert",
    description: "Convert text subtitle tracks to SubRip (SRT); ASS/SSA styling is lost. Video and audio are copied.",
    irreversible: true,
    outputExtension: ".mkv",
    stagingFactor: 1.05,
    ffmpegArgs: (input, output) => [...COMMON_PREFIX, "-i", input, "-map", "0", "-c:v", "copy", "-c:a", "copy", "-c:s", "srt", output],
    validate: (input, output) => [
      ...sameCodecs(input, output, "video"),
      ...sameCodecs(input, output, "audio"),
      ...sameCount(input, output, "subtitle"),
      ...allCodecs(output, "subtitle", ["subrip"]),
      ...durationConforms(input, output),
    ],
  },
  cpu_hevc_transcode: {
    name: "cpu_hevc_transcode",
    action: "transcode",
    description: "Re-encode video to HEVC (libx265, CRF 28, preset fast) on CPU; audio and subtitles copied.",
    irreversible: true,
    outputExtension: ".mkv",
    stagingFactor: 1.0,
    ffmpegArgs: (input, output) => [
      ...COMMON_PREFIX, "-i", input, "-map", "0",
      "-c:v", "libx265", "-preset", "fast", "-crf", "28",
      "-c:a", "copy", "-c:s", "copy", output,
    ],
    validate: (input, output) => [
      ...sameCount(input, output, "video"),
      ...allCodecs(output, "video", ["hevc"]),
      ...sameCodecs(input, output, "audio"),
      ...sameCount(input, output, "subtitle"),
      ...durationConforms(input, output),
    ],
  },
  cpu_av1_transcode: {
    name: "cpu_av1_transcode",
    action: "transcode",
    description: "Re-encode video to AV1 (SVT-AV1, CRF 30, preset 6) and audio to Opus 128k on CPU; subtitles copied.",
    irreversible: true,
    outputExtension: ".mkv",
    stagingFactor: 1.0,
    ffmpegArgs: (input, output) => [
      ...COMMON_PREFIX, "-i", input, "-map", "0",
      "-c:v", "libsvtav1", "-preset", "6", "-crf", "30",
      "-c:a", "libopus", "-b:a", "128k", "-c:s", "copy", output,
    ],
    validate: (input, output) => [
      ...sameCount(input, output, "video"),
      ...allCodecs(output, "video", ["av1"]),
      ...sameCount(input, output, "audio"),
      ...allCodecs(output, "audio", ["opus"]),
      ...sameCount(input, output, "subtitle"),
      ...durationConforms(input, output),
    ],
  },
};

export const DEFAULT_PROFILE_BY_ACTION: Record<MediaAction, string> = {
  remux: "mkv_remux",
  "subtitle-convert": "srt_subtitles",
  transcode: "cpu_hevc_transcode",
};

export function resolveProfile(action: MediaAction, profileName?: string): MediaProfile {
  const name = profileName && profileName !== "default" ? profileName : DEFAULT_PROFILE_BY_ACTION[action];
  const profile = name ? MEDIA_PROFILES[name] : undefined;
  if (!profile || profile.action !== action) {
    throw new MediaJobError(`Unsupported media profile: ${action} / ${profileName ?? "default"}`, "ERR_UNSUPPORTED_PROFILE", {
      supported: Object.values(MEDIA_PROFILES).filter((p) => p.action === action).map((p) => p.name),
    });
  }
  return profile;
}

export function listProfiles(): Array<{ name: string; action: MediaAction; description: string; irreversible: boolean }> {
  return Object.values(MEDIA_PROFILES).map((p) => ({ name: p.name, action: p.action, description: p.description, irreversible: p.irreversible }));
}

/** Parses `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbe(json: string): ProbeSummary {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new MediaJobError("ffprobe produced invalid JSON", "ERR_PROBE_FAILED");
  }
  const streams: ProbeStream[] = Array.isArray(parsed?.streams)
    ? parsed.streams.map((s: any, i: number) => ({
        index: typeof s.index === "number" ? s.index : i,
        type: String(s.codec_type ?? "unknown"),
        codec: String(s.codec_name ?? "unknown"),
        language: s.tags?.language ? String(s.tags.language) : undefined,
        title: s.tags?.title ? String(s.tags.title) : undefined,
        isDefault: s.disposition?.default === 1,
        width: typeof s.width === "number" ? s.width : undefined,
        height: typeof s.height === "number" ? s.height : undefined,
        channels: typeof s.channels === "number" ? s.channels : undefined,
      }))
    : [];
  const durationSec = Number.parseFloat(parsed?.format?.duration ?? "0");
  const sizeBytes = parsed?.format?.size !== undefined ? Number.parseInt(String(parsed.format.size), 10) : undefined;
  return {
    formatName: parsed?.format?.format_name ? String(parsed.format.format_name) : undefined,
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    sizeBytes: sizeBytes !== undefined && Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    streams,
  };
}

export async function probeFile(absolutePath: string, runner: CommandRunner = defaultCommandRunner, signal?: AbortSignal): Promise<ProbeSummary> {
  let stdout: string;
  try {
    const res = await runner("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absolutePath], {
      signal,
      timeoutMs: 120_000,
    });
    stdout = res.stdout;
  } catch (err: any) {
    if (signal?.aborted) throw new MediaJobError("Probe cancelled", "ERR_CANCELLED");
    throw new MediaJobError(`ffprobe failed: ${err?.message ?? err}`, "ERR_PROBE_FAILED");
  }
  const summary = parseProbe(stdout);
  if (summary.streams.length === 0 || !(summary.durationSec > 0)) {
    throw new MediaJobError("ffprobe reported no streams or zero duration", "ERR_PROBE_FAILED");
  }
  return summary;
}

export interface MediaTarget {
  rootId: string;
  relativePath: string;
  expectedIdentity?: PlannedTargetFileIdentity;
}

export async function inspectMedia(target: { rootId: string; relativePath: string }, runner: CommandRunner = defaultCommandRunner): Promise<ProbeSummary> {
  const resolved = await defaultRootFs.resolveWithinRoot(target.rootId, target.relativePath, { mustExist: true, expectKind: "file" });
  return probeFile(resolved.absolutePath, runner);
}

export interface MediaJobOptions {
  planId: string;
  signal?: AbortSignal;
  runner?: CommandRunner;
  ffmpegTimeoutMs?: number;
  /** Test seam: bytes available on the volume that hosts `dir`. Defaults to statfs. */
  freeSpaceProbe?: (dir: string) => Promise<number>;
}

export interface MediaJobResult {
  profile: string;
  action: MediaAction;
  /** Relative path where the validated output was published. */
  outputRelativePath: string;
  /** Quarantine entry holding the original (recoverable for the retention window). */
  backupEntryPath: string;
  input: { durationSec: number; sizeBytes?: number; streams: number };
  output: { durationSec: number; sizeBytes?: number; streams: number };
}

async function defaultFreeSpace(dir: string): Promise<number> {
  const s = await fs.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function replaceExtension(relativePath: string, ext: string): string {
  const parsed = path.posix.parse(relativePath);
  return path.posix.join(parsed.dir, `${parsed.name}${ext}`);
}

export async function executeMediaJob(target: MediaTarget, profile: MediaProfile, opts: MediaJobOptions): Promise<MediaJobResult> {
  const runner = opts.runner ?? defaultCommandRunner;
  const signal = opts.signal;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new MediaJobError("Job cancelled before completion", "ERR_CANCELLED");
  };

  throwIfAborted();
  const resolved = await defaultRootFs.resolveWithinRoot(target.rootId, target.relativePath, { mustExist: true, expectKind: "file" });
  if (target.expectedIdentity) {
    await defaultRootFs.assertIdentity(resolved.absolutePath, target.expectedIdentity);
  }
  const identity = await defaultRootFs.getFileIdentity(resolved.absolutePath);
  const inputSize = identity.sizeBytes ?? 0;

  const inputProbe = await probeFile(resolved.absolutePath, runner, signal);

  // Reserve staging on the same volume before spending CPU.
  const stagingDir = path.join(resolved.canonicalRoot, STAGING_DIR_NAME, opts.planId);
  await fs.mkdir(stagingDir, { recursive: true });
  const free = await (opts.freeSpaceProbe ?? defaultFreeSpace)(resolved.canonicalRoot);
  const needed = Math.ceil(inputSize * profile.stagingFactor);
  if (free < needed) {
    throw new MediaJobError(
      `Insufficient free space for staging: need ${needed} bytes, ${free} available`,
      "ERR_INSUFFICIENT_SPACE",
      { needed, free }
    );
  }

  const parsedName = path.posix.parse(resolved.relativePath);
  const stagingPath = path.join(stagingDir, `${parsedName.name}.${randomUUID().slice(0, 8)}${profile.outputExtension}`);

  const cleanupStaging = async () => {
    await fs.rm(stagingPath, { force: true }).catch(() => {});
    await fs.rmdir(stagingDir).catch(() => {});
  };

  try {
    await runner("ffmpeg", profile.ffmpegArgs(resolved.absolutePath, stagingPath), {
      signal,
      timeoutMs: opts.ffmpegTimeoutMs ?? 6 * 60 * 60 * 1000,
    });
  } catch (err: any) {
    await cleanupStaging();
    if (signal?.aborted) throw new MediaJobError("Job cancelled; ffmpeg terminated and staging removed", "ERR_CANCELLED");
    throw new MediaJobError(`ffmpeg failed: ${err?.message ?? err}`, "ERR_FFMPEG_FAILED");
  }

  if (signal?.aborted) {
    await cleanupStaging();
    throw new MediaJobError("Job cancelled after encoding; output discarded", "ERR_CANCELLED");
  }

  let outputProbe: ProbeSummary;
  try {
    outputProbe = await probeFile(stagingPath, runner, signal);
  } catch (err) {
    await cleanupStaging();
    if (err instanceof MediaJobError && err.code === "ERR_CANCELLED") throw err;
    throw new MediaJobError(`Output failed validation: ${(err as Error).message}`, "ERR_OUTPUT_INVALID");
  }
  const violations = profile.validate(inputProbe, outputProbe);
  if (violations.length > 0) {
    await cleanupStaging();
    throw new MediaJobError(`Output does not conform to profile ${profile.name}: ${violations.join("; ")}`, "ERR_OUTPUT_INVALID", { violations });
  }

  // Recoverable replacement: original -> quarantine entry, then publish output.
  const publishRelative = replaceExtension(resolved.relativePath, profile.outputExtension);
  const publishAbs = path.join(resolved.canonicalRoot, ...publishRelative.split("/"));

  if (publishRelative !== resolved.relativePath) {
    const existing = await defaultRootFs.resolveWithinRoot(target.rootId, publishRelative);
    if (existing.exists) {
      await cleanupStaging();
      throw new MediaJobError(`Publish target already exists: ${publishRelative}`, "ERR_REPLACE_FAILED");
    }
  }

  let backup;
  try {
    backup = await quarantineFile(target.rootId, resolved.relativePath, {
      planId: opts.planId,
      expectedIdentity: target.expectedIdentity ?? identity,
    });
  } catch (err: any) {
    await cleanupStaging();
    throw new MediaJobError(`Could not move original into quarantine: ${err?.message ?? err}`, "ERR_REPLACE_FAILED");
  }

  try {
    await fs.rename(stagingPath, publishAbs);
  } catch (err: any) {
    let restored = false;
    try {
      await restoreQuarantined(target.rootId, backup.entryPath);
      restored = true;
    } catch {
      restored = false;
    }
    await cleanupStaging();
    throw new MediaJobError(
      restored
        ? `Publishing the output failed (${err?.message ?? err}); original restored in place`
        : `Publishing the output failed (${err?.message ?? err}); original preserved in quarantine entry ${backup.entryPath}`,
      "ERR_REPLACE_FAILED",
      { restored, backupEntryPath: backup.entryPath }
    );
  }

  await fs.rmdir(stagingDir).catch(() => {});

  return {
    profile: profile.name,
    action: profile.action,
    outputRelativePath: publishRelative,
    backupEntryPath: backup.entryPath,
    input: { durationSec: inputProbe.durationSec, sizeBytes: inputSize, streams: inputProbe.streams.length },
    output: { durationSec: outputProbe.durationSec, sizeBytes: outputProbe.sizeBytes, streams: outputProbe.streams.length },
  };
}
