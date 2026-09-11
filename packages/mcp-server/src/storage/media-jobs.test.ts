/**
 * Gate G05 / Phase P05: recoverable media jobs (MED-01, MED-02, MED-04, MED-05, MED-06).
 * ffmpeg/ffprobe are replaced by a scripted runner; the real-binary check lives
 * in scripts/ci/smoke-media-ffmpeg.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Principal } from "@mediabox/contracts";
import { defaultRootFs } from "./rootfs.js";
import { listQuarantine, QUARANTINE_DIR_NAME, STAGING_DIR_NAME } from "./quarantine.js";
import {
  MEDIA_PROFILES,
  resolveProfile,
  parseProbe,
  executeMediaJob,
  inspectMedia,
  setDefaultCommandRunner,
  MediaJobError,
  type CommandRunner,
  type ProbeSummary,
} from "./media-jobs.js";
import { createMediaFormatPlan } from "../operations/planners/media-format.js";
import { NodeSqliteAdapter } from "../operations/sqlite/node-adapter.js";
import { OperationStore } from "../operations/store.js";
import { OperationExecutor } from "../operations/executor.js";
import { registerStepHandlers } from "../operations/handlers.js";
import { OWNER_PRINCIPAL_ID, type PlanScope } from "../security/context.js";

const scope: PlanScope = { installationId: "inst", ownerId: OWNER_PRINCIPAL_ID, conversationId: "conv" };
const owner: Principal = {
  id: OWNER_PRINCIPAL_ID,
  installationId: "inst",
  kind: "owner-ui",
  capabilities: ["*"],
  audience: "mediabox-local",
  sessionId: "s",
  expiresAt: Date.now() + 3_600_000,
  credentialVersion: 1,
};

type StreamSpec = { codec_type: string; codec_name: string; tags?: Record<string, string> };
const H264_AAC: StreamSpec[] = [{ codec_type: "video", codec_name: "h264" }, { codec_type: "audio", codec_name: "aac", tags: { language: "spa" } }];

function probeJson(duration: number, streams: StreamSpec[], size = 1000): string {
  return JSON.stringify({ format: { duration: String(duration), size: String(size), format_name: "matroska" }, streams: streams.map((s, i) => ({ index: i, ...s })) });
}

interface RunnerScript {
  inputStreams?: StreamSpec[];
  outputStreams?: StreamSpec[];
  outputDuration?: number;
  ffmpegFails?: boolean;
  outputProbeInvalid?: boolean;
  ffmpegWaitsForAbort?: boolean;
  onFfmpeg?: (args: string[]) => void;
}

function scriptedRunner(script: RunnerScript = {}): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner & { calls: string[] } = Object.assign(
    async (file: "ffmpeg" | "ffprobe", args: string[], opts: { signal?: AbortSignal }) => {
      calls.push(file);
      const target = args[args.length - 1];
      if (file === "ffprobe") {
        const isStaging = target.includes(STAGING_DIR_NAME);
        if (isStaging && script.outputProbeInvalid) return { stdout: "not json", stderr: "" };
        const streams = isStaging ? script.outputStreams ?? H264_AAC : script.inputStreams ?? H264_AAC;
        return { stdout: probeJson(isStaging ? script.outputDuration ?? 120 : 120, streams), stderr: "" };
      }
      script.onFfmpeg?.(args);
      if (script.ffmpegWaitsForAbort) {
        await new Promise<void>((_resolve, reject) => {
          if (opts.signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          opts.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }
      if (script.ffmpegFails) throw new Error("ffmpeg exited with code 1");
      await fs.writeFile(target, "encoded-output");
      return { stdout: "", stderr: "" };
    },
    { calls }
  );
  return runner;
}

let base: string;
let root: string;

async function write(rel: string, content = "original-bytes"): Promise<string> {
  const abs = path.join(root, ...rel.split("/"));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return abs;
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(root, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

async function stagingLeftovers(): Promise<string[]> {
  try {
    const dir = path.join(root, STAGING_DIR_NAME);
    const out: string[] = [];
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory()) out.push(...(await fs.readdir(path.join(dir, d.name))));
      else out.push(d.name);
    }
    return out;
  } catch {
    return [];
  }
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "mbx-g05-"));
  root = path.join(base, "media");
  await fs.mkdir(root, { recursive: true });
  defaultRootFs.resetForTesting();
  defaultRootFs.registerRoot("media", root);
});

afterEach(async () => {
  setDefaultCommandRunner(null);
  defaultRootFs.resetForTesting();
  await fs.rm(base, { recursive: true, force: true });
});

describe("Closed profiles and probing (MED-04)", () => {
  it("resolves defaults per action and rejects unknown or mismatched profiles", () => {
    expect(resolveProfile("remux").name).toBe("mkv_remux");
    expect(resolveProfile("subtitle-convert").name).toBe("srt_subtitles");
    expect(resolveProfile("transcode").name).toBe("cpu_hevc_transcode");
    expect(resolveProfile("transcode", "cpu_av1_transcode").name).toBe("cpu_av1_transcode");
    expect(() => resolveProfile("remux", "cpu_hevc_transcode")).toThrowError(MediaJobError);
    expect(() => resolveProfile("transcode", "ffmpeg -c:v whatever")).toThrowError(/Unsupported/);
  });

  it("validates outputs against the declared profile", () => {
    const input: ProbeSummary = parseProbe(probeJson(120, [...H264_AAC, { codec_type: "subtitle", codec_name: "ass" }]));
    const hevc = parseProbe(probeJson(120, [{ codec_type: "video", codec_name: "hevc" }, { codec_type: "audio", codec_name: "aac" }, { codec_type: "subtitle", codec_name: "ass" }]));
    expect(MEDIA_PROFILES.cpu_hevc_transcode.validate(input, hevc)).toEqual([]);
    const stillH264 = parseProbe(probeJson(120, [...H264_AAC, { codec_type: "subtitle", codec_name: "ass" }]));
    expect(MEDIA_PROFILES.cpu_hevc_transcode.validate(input, stillH264).join(" ")).toMatch(/codec h264 not in hevc/);
    expect(MEDIA_PROFILES.mkv_remux.validate(input, parseProbe(probeJson(60, [...H264_AAC, { codec_type: "subtitle", codec_name: "ass" }]))).join(" ")).toMatch(/duration/);
    expect(MEDIA_PROFILES.mkv_remux.validate(input, parseProbe(probeJson(120, H264_AAC))).join(" ")).toMatch(/subtitle stream count/);
    const srt = parseProbe(probeJson(120, [...H264_AAC, { codec_type: "subtitle", codec_name: "subrip" }]));
    expect(MEDIA_PROFILES.srt_subtitles.validate(input, srt)).toEqual([]);
    expect(MEDIA_PROFILES.srt_subtitles.validate(input, input).join(" ")).toMatch(/codec ass not in subrip/);
    expect(input.streams[1].language).toBe("spa");
  });

  it("inspectMedia is confined to the root", async () => {
    await write("tv/a.mkv");
    const probe = await inspectMedia({ rootId: "media", relativePath: "tv/a.mkv" }, scriptedRunner());
    expect(probe.streams).toHaveLength(2);
    await expect(inspectMedia({ rootId: "media", relativePath: "../a.mkv" }, scriptedRunner())).rejects.toMatchObject({ code: "ERR_PATH_INVALID" });
  });
});

describe("Planner", () => {
  it("captures identity, closed profile, destination and staging resources", async () => {
    await write("movies/Film/film.mp4", "1234567890");
    const { plan, summary } = await createMediaFormatPlan({ logicalPath: "movies/Film/film.mp4", action: "remux", scope });
    expect(plan.operation).toBe("media_format_conversion");
    expect(plan.targets[0].fileIdentity?.kind).toBe("file");
    expect(plan.effects[0]).toMatchObject({ serviceAction: "media.remux", tracksProfile: "mkv_remux", destination: "movies/Film/film.mkv", irreversibleLoss: false });
    expect(plan.effects[0].requiredResources).toMatchObject({ selectedBytes: 10, reclaimableBytes: 0, estimatedDiskBytes: 11 });
    expect(summary.hardLinked).toBe(false);
    await expect(createMediaFormatPlan({ logicalPath: "movies/Film/film.mp4", action: "transcode", profileName: "bogus", scope })).rejects.toThrowError(MediaJobError);
  });
});

describe("Recoverable replacement (MED-01 / MED-02 / MED-05)", () => {
  it("publishes a validated output and keeps the original in the plan's quarantine entry", async () => {
    const abs = await write("movies/Film (2019)/Película ñ.mp4");
    const runner = scriptedRunner();
    const res = await executeMediaJob({ rootId: "media", relativePath: "movies/Film (2019)/Película ñ.mp4" }, MEDIA_PROFILES.mkv_remux, { planId: "plan_1", runner });
    expect(res.outputRelativePath).toBe("movies/Film (2019)/Película ñ.mkv");
    expect(res.backupEntryPath).toBe("plan_1/movies/Film (2019)/Película ñ.mp4");
    expect(await fs.readFile(path.join(root, "movies", "Film (2019)", "Película ñ.mkv"), "utf8")).toBe("encoded-output");
    expect(await exists("movies/Film (2019)/Película ñ.mp4")).toBe(false);
    expect(await fs.readFile(path.join(root, QUARANTINE_DIR_NAME, "plan_1", "movies", "Film (2019)", "Película ñ.mp4"), "utf8")).toBe("original-bytes");
    expect(await stagingLeftovers()).toEqual([]);
    expect(runner.calls).toEqual(["ffprobe", "ffmpeg", "ffprobe"]);
    expect(abs).toContain("Película");
  });

  it("refuses to start when the volume lacks staging space (MED-01)", async () => {
    await write("tv/a.mkv");
    const runner = scriptedRunner();
    await expect(
      executeMediaJob({ rootId: "media", relativePath: "tv/a.mkv" }, MEDIA_PROFILES.mkv_remux, { planId: "p", runner, freeSpaceProbe: async () => 0 })
    ).rejects.toMatchObject({ code: "ERR_INSUFFICIENT_SPACE" });
    expect(runner.calls).not.toContain("ffmpeg");
    expect(await fs.readFile(path.join(root, "tv", "a.mkv"), "utf8")).toBe("original-bytes");
  });

  it("discards an output that fails validation and keeps the original (MED-01)", async () => {
    await write("tv/a.mkv");
    await expect(
      executeMediaJob({ rootId: "media", relativePath: "tv/a.mkv" }, MEDIA_PROFILES.cpu_hevc_transcode, { planId: "p", runner: scriptedRunner({ outputStreams: H264_AAC }) })
    ).rejects.toMatchObject({ code: "ERR_OUTPUT_INVALID" });
    expect(await fs.readFile(path.join(root, "tv", "a.mkv"), "utf8")).toBe("original-bytes");
    expect(await stagingLeftovers()).toEqual([]);
    expect(await listQuarantine("media")).toHaveLength(0);
  });

  it("survives an injected failure at every transition without losing the original (MED-02)", async () => {
    await write("tv/a.mkv");
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ["ffmpeg fails", () => executeMediaJob({ rootId: "media", relativePath: "tv/a.mkv" }, MEDIA_PROFILES.mkv_remux, { planId: "p1", runner: scriptedRunner({ ffmpegFails: true }) }), "ERR_FFMPEG_FAILED"],
      ["output probe fails", () => executeMediaJob({ rootId: "media", relativePath: "tv/a.mkv" }, MEDIA_PROFILES.mkv_remux, { planId: "p2", runner: scriptedRunner({ outputProbeInvalid: true }) }), "ERR_OUTPUT_INVALID"],
    ];
    for (const [, run, code] of cases) {
      await expect(run()).rejects.toMatchObject({ code });
      expect(await fs.readFile(path.join(root, "tv", "a.mkv"), "utf8")).toBe("original-bytes");
      expect(await stagingLeftovers()).toEqual([]);
    }

    // Quarantine entry already occupied: the original is not moved.
    await fs.mkdir(path.join(root, QUARANTINE_DIR_NAME, "p3", "tv"), { recursive: true });
    await fs.writeFile(path.join(root, QUARANTINE_DIR_NAME, "p3", "tv", "a.mkv"), "occupied");
    await expect(
      executeMediaJob({ rootId: "media", relativePath: "tv/a.mkv" }, MEDIA_PROFILES.mkv_remux, { planId: "p3", runner: scriptedRunner() })
    ).rejects.toMatchObject({ code: "ERR_REPLACE_FAILED" });
    expect(await fs.readFile(path.join(root, "tv", "a.mkv"), "utf8")).toBe("original-bytes");

    // Publish target already exists (mp4 -> mkv): refused before touching the original.
    await write("tv/b.mp4");
    await write("tv/b.mkv", "someone else's file");
    await expect(
      executeMediaJob({ rootId: "media", relativePath: "tv/b.mp4" }, MEDIA_PROFILES.mkv_remux, { planId: "p4", runner: scriptedRunner() })
    ).rejects.toMatchObject({ code: "ERR_REPLACE_FAILED" });
    expect(await fs.readFile(path.join(root, "tv", "b.mp4"), "utf8")).toBe("original-bytes");
    expect(await fs.readFile(path.join(root, "tv", "b.mkv"), "utf8")).toBe("someone else's file");
    expect(await stagingLeftovers()).toEqual([]);
  });

  it("refuses to run when the file changed after the plan was built (INV-TARGET)", async () => {
    const abs = await write("tv/c.mkv");
    const { plan } = await createMediaFormatPlan({ logicalPath: "tv/c.mkv", action: "remux", scope });
    await fs.appendFile(abs, "-modified");
    setDefaultCommandRunner(scriptedRunner());
    const store = new OperationStore(new NodeSqliteAdapter(":memory:"));
    const executor = new OperationExecutor(store, { workerId: "w", heartbeatMs: 20 });
    registerStepHandlers(executor);
    store.createPlan(plan, "awaiting_approval");
    store.approveAndEnqueue(plan.id, owner, plan.manifestHash);
    await executor.pollAndExecute();
    const record = store.getPlan(plan.id)!;
    expect(record.status).toBe("failed");
    expect(record.steps![0].error).toMatch(/identity/i);
    expect(await fs.readFile(abs, "utf8")).toBe("original-bytes-modified");
  });

  it("flags hard-linked originals in the plan summary (MED-05)", async () => {
    const abs = await write("tv/hl.mkv");
    await fs.link(abs, path.join(root, "tv", "hl-link.mkv"));
    const { summary, plan } = await createMediaFormatPlan({ logicalPath: "tv/hl.mkv", action: "remux", scope });
    expect(summary.hardLinked).toBe(true);
    expect(plan.targets[0].fileIdentity?.nlink).toBe(2);
  });
});

describe("Cancellation (MED-06)", () => {
  it("terminates the encoder on cancel, ends cancelled and leaves the original and no staging", async () => {
    const abs = await write("tv/long.mkv");
    setDefaultCommandRunner(scriptedRunner({ ffmpegWaitsForAbort: true }));
    const { plan } = await createMediaFormatPlan({ logicalPath: "tv/long.mkv", action: "transcode", scope });
    const store = new OperationStore(new NodeSqliteAdapter(":memory:"));
    const executor = new OperationExecutor(store, { workerId: "w", heartbeatMs: 20 });
    registerStepHandlers(executor);
    store.createPlan(plan, "awaiting_approval");
    store.approveAndEnqueue(plan.id, owner, plan.manifestHash);

    const running = executor.pollAndExecute();
    await new Promise((r) => setTimeout(r, 60));
    expect(store.getPlan(plan.id)!.status).toBe("running");
    expect(store.cancelPlan(plan.id, owner).status).toBe("cancel_requested");
    await running;

    const record = store.getPlan(plan.id)!;
    expect(record.status).toBe("cancelled");
    expect(record.status).not.toBe("succeeded");
    expect(await fs.readFile(abs, "utf8")).toBe("original-bytes");
    expect(await stagingLeftovers()).toEqual([]);
    expect(await listQuarantine("media")).toHaveLength(0);
  });
});
