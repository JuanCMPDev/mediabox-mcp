/**
 * Results that name what is unknown (G10 READ-07 and STORAGE-05, experiments 5 and 6).
 * The local models took the one disk server_status reports for a backup disk it does
 * not report, and read tiny sizes ("0.0MB", "0 KB") as wrong or as space a cleanup frees.
 * Whatever the model must see has to survive the agent's result compaction.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// config.ts reads MEDIA_PATH at import time: point it at a folder statfs can read.
const env = vi.hoisted(() => {
  const previous = process.env.MEDIA_PATH;
  const media = (process.env.TEMP || process.env.TMPDIR || process.env.TMP || "/tmp").replace(/\\/g, "/");
  process.env.MEDIA_PATH = media;
  return { previous, media };
});

const upstream = vi.hoisted(() => ({ jellyfin: vi.fn(), count: vi.fn() }));
vi.mock("../helpers/api.js", () => ({
  jfApi: upstream.jellyfin,
  jfCountByParent: upstream.count,
  textResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
}));

import { describeMediaDisk, registerJellyfinTools, MEDIA_DISK_NOTE, NO_DISK_NOTE } from "./jellyfin.js";
import { formatBytes } from "../fetchers/utils.js";
import { compactToolResult, TOOL_RESULT_STRING_CAP } from "../../../chat-core/src/agent/budget.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

afterEach(() => vi.resetAllMocks());

afterAll(() => {
  if (env.previous === undefined) delete process.env.MEDIA_PATH;
  else process.env.MEDIA_PATH = env.previous;
});

const GIB = 1_073_741_824;

describe("formatBytes", () => {
  it("names sizes below 1 KB in bytes and keeps the larger ranges", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
    expect(formatBytes(16.3 * GIB)).toBe("16.3 GB");
    expect(formatBytes(2 * 1_099_511_627_776)).toBe("2.0 TB");
  });
});

describe("describeMediaDisk", () => {
  it("names the media library disk, keeps its fields and says any other disk is unknown", () => {
    // 100 GiB in 4 KiB blocks, a quarter free.
    const { disk, diskNote } = describeMediaDisk("/data", { blocks: 26_214_400, bsize: 4096, bfree: 6_553_600 });
    expect(disk).toEqual({ name: "media library", path: "/data", total: "100.0 GB", used: "75.0 GB", free: "25.0 GB", usedPercent: 75 });
    expect(diskNote).toBe(MEDIA_DISK_NOTE);
    // READ-07: the figures are bound to the media library disk, never to a backup disk.
    expect(diskNote).toMatch(/^These figures are for the media library disk only;/);
    expect(diskNote).toMatch(/backup, external/);
  });

  it("never claims that no other disk is configured (review finding D3)", () => {
    // server_status reads MEDIA_PATH only: another disk may exist and is simply unknown.
    for (const note of [MEDIA_DISK_NOTE, NO_DISK_NOTE]) {
      expect(note).not.toMatch(/configured/i);
      expect(note).toMatch(/any other disk \(backup, external\) is unknown/);
    }
  });

  it("accepts bigint block counts and reports an empty filesystem as 0 percent", () => {
    expect(describeMediaDisk("/data", { blocks: 0n, bsize: 4096n, bfree: 0n }).disk).toMatchObject({ total: "0 B", usedPercent: 0 });
  });

  it("keeps disk \"N/A\" when the disk could not be read and says its space is unknown", () => {
    expect(describeMediaDisk("/data", null)).toEqual({ disk: "N/A", diskNote: NO_DISK_NOTE });
    expect(NO_DISK_NOTE).toMatch(/^Disk space is unknown: the media library disk could not be read;/);
    // D3: "no disk space is available" reads as a full disk.
    expect(NO_DISK_NOTE).not.toMatch(/no disk space/i);
  });

  it("both notes fit the string cap compaction keeps", () => {
    for (const note of [MEDIA_DISK_NOTE, NO_DISK_NOTE]) expect(note.length).toBeLessThanOrEqual(TOOL_RESULT_STRING_CAP);
  });
});

describe("server_status", () => {
  function serverStatus(): Handler {
    const tools = new Map<string, Handler>();
    registerJellyfinTools({ registerTool: (name: string, _config: unknown, handler: Handler) => tools.set(name, handler) } as any);
    return tools.get("server_status")!;
  }

  it("names the disk and its note, and both reach the model through compaction", async () => {
    upstream.jellyfin.mockImplementation(async (endpoint: string) =>
      endpoint === "/System/Info" ? { ServerName: "mediabox", Version: "10.10.7", OperatingSystem: "Linux" } : []);
    const text = (await serverStatus()({})).content[0].text;
    const payload = JSON.parse(text);
    expect(payload.disk).toMatchObject({ name: "media library", path: env.media });
    expect(Object.keys(payload.disk)).toEqual(["name", "path", "total", "used", "free", "usedPercent"]);
    expect(payload.diskNote).toBe(MEDIA_DISK_NOTE);

    const compacted = JSON.parse(compactToolResult("server_info", text));
    expect(compacted.diskNote).toBe(MEDIA_DISK_NOTE);
    expect(compacted.disk).toMatchObject({ name: "media library", free: payload.disk.free });
  });
});

describe("propose_cleanup freedNow", () => {
  it("survives compaction next to the warnings and the selected size", () => {
    const raw = JSON.stringify({
      status: "ok",
      data: {
        planId: "plan_s05", operation: "quarantine_files", status: "awaiting_approval",
        warnings: ["Quarantine frees 0 B now: the files stay on the same disk until an approved purge."],
        selectedSize: formatBytes(4096), freedNow: formatBytes(0),
        summary: { files: 1, directories: 0, selectedBytes: 4096, reclaimableBytes: 0, hardLinkedFiles: 0, paths: ["media:tv/Show/a.nfo"] },
        message: "Plan plan_s05 awaits owner approval in the Mediabox app.",
      },
    });
    expect(JSON.parse(compactToolResult("library_ops", raw)).data).toMatchObject({ selectedSize: "4 KB", freedNow: "0 B" });
  });
});
