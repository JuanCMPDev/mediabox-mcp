/**
 * Smoke tests that the sandbox is actually wired into tools — not just
 * present as a helper. Without these, a future tool that builds paths
 * directly via path.join could ship a traversal regression.
 *
 * Pattern: capture tool handlers via a fake McpServer, then exercise
 * malicious inputs that should reject before any disk / API operation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../helpers/api.js", () => ({
  jfApi: vi.fn().mockResolvedValue({}),
  sonarrApi: vi.fn().mockResolvedValue({}),
  radarrApi: vi.fn().mockResolvedValue({}),
  textResult: (x: unknown) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }),
}));
vi.mock("../helpers/pyload.js", () => ({
  pyloadApi: vi.fn().mockResolvedValue({}),
  pyloadApiJson: vi.fn().mockResolvedValue({}),
}));
vi.mock("../helpers/qbittorrent.js", () => ({
  qbitApi: vi.fn().mockResolvedValue({}),
}));

import { registerLibraryTools } from "./library.js";
import { registerDownloadTools } from "./downloads.js";
import { registerMaintenanceTools } from "./maintenance.js";

interface CapturedTool {
  handler: (args: any) => Promise<any> | any;
}

class FakeServer {
  tools = new Map<string, CapturedTool>();
  registerTool(name: string, _config: unknown, handler: any): void {
    this.tools.set(name, { handler });
  }
}

function loadLibraryTools() {
  const fake = new FakeServer();
  registerLibraryTools(fake as any);
  return fake.tools;
}

function loadDownloadTools() {
  const fake = new FakeServer();
  registerDownloadTools(fake as any);
  return fake.tools;
}

function loadMaintenanceTools() {
  const fake = new FakeServer();
  registerMaintenanceTools(fake as any);
  return fake.tools;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("path sandbox is wired into library tools", () => {
  it("manage_files delete rejects ../etc/passwd", async () => {
    const tools = loadLibraryTools();
    const handler = tools.get("manage_files")!.handler;
    await expect(handler({ action: "delete", path: "../etc/passwd" })).rejects.toThrow(
      /escapes (media|downloads) sandbox/,
    );
  });

  it("manage_files list rejects /etc", async () => {
    const tools = loadLibraryTools();
    const handler = tools.get("manage_files")!.handler;
    await expect(handler({ action: "list", path: "/etc" })).rejects.toThrow(/escapes/);
  });

  it("rename_episodes rejects ../etc/passwd", async () => {
    const tools = loadLibraryTools();
    const handler = tools.get("rename_episodes")!.handler;
    await expect(
      handler({ showPath: "../etc", showName: "X", seasonNumber: 1, startEpisodeNumber: 1, dryRun: true }),
    ).rejects.toThrow(/escapes/);
  });

  it("fix_subtitles rejects /etc", async () => {
    const tools = loadLibraryTools();
    const handler = tools.get("fix_subtitles")!.handler;
    await expect(handler({ mediaPath: "/etc", dryRun: true })).rejects.toThrow(/escapes/);
  });
});

describe("path sandbox is wired into maintenance tools", () => {
  it("optimize_media rejects /etc", async () => {
    const tools = loadMaintenanceTools();
    const handler = tools.get("optimize_media")!.handler;
    await expect(handler({ mediaPath: "/etc", action: "analyze" })).rejects.toThrow(/escapes/);
  });
});

describe("segment guards are wired into download tools", () => {
  it("download_status organize rejects '..' as packageFolder", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_status")!.handler;
    await expect(
      handler({ action: "organize", packageFolder: "..", showName: "Movie", libraryFolder: "movies" }),
    ).rejects.toThrow(/Unsafe path segment/);
  });

  it("download_status organize rejects path separators in showName", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_status")!.handler;
    await expect(
      handler({ action: "organize", packageFolder: "ok", showName: "../etc", libraryFolder: "movies" }),
    ).rejects.toThrow(/Unsafe path segment/);
  });

  it("download_direct rejects '..' as showName", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_direct")!.handler;
    await expect(
      handler({ url: "https://example.com/x.zip", showName: "..", libraryFolder: "movies" }),
    ).rejects.toThrow(/Unsafe path segment/);
  });
});

describe("URL allowlist is wired into download tools (P1.1)", () => {
  it("download_add rejects file:// scheme", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_add")!.handler;
    await expect(
      handler({ urls: ["file:///etc/passwd"], packageName: "ok" }),
    ).rejects.toThrow(/URL rejected/);
  });

  it("download_add rejects private IPv4 literals", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_add")!.handler;
    await expect(
      handler({ urls: ["http://10.0.0.5/x.zip"], packageName: "ok" }),
    ).rejects.toThrow(/private IPv4/);
  });

  it("download_add rejects the cloud metadata endpoint", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_add")!.handler;
    await expect(
      handler({ urls: ["http://169.254.169.254/latest/meta-data"], packageName: "ok" }),
    ).rejects.toThrow(/private IPv4/);
  });

  it("download_add rejects when ANY url in the batch is bad", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_add")!.handler;
    await expect(
      handler({
        urls: ["https://example.com/good.zip", "http://127.0.0.1/bad"],
        packageName: "ok",
      }),
    ).rejects.toThrow(/URL rejected/);
  });

  it("download_direct rejects file:// scheme", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_direct")!.handler;
    await expect(
      handler({ url: "file:///etc/passwd", showName: "Show", libraryFolder: "movies" }),
    ).rejects.toThrow(/URL rejected/);
  });

  it("download_direct rejects private IPv4 literal", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_direct")!.handler;
    await expect(
      handler({ url: "http://192.168.1.1/x", showName: "Show", libraryFolder: "movies" }),
    ).rejects.toThrow(/private IPv4/);
  });

  it("download_direct rejects loopback IPv6", async () => {
    const tools = loadDownloadTools();
    const handler = tools.get("download_direct")!.handler;
    await expect(
      handler({ url: "http://[::1]/x", showName: "Show", libraryFolder: "movies" }),
    ).rejects.toThrow(/private IPv6/);
  });
});
