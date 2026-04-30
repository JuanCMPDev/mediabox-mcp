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

import { jfApi, sonarrApi, radarrApi } from "../helpers/api.js";
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

describe("confirm tokens are wired into destructive tools (P1.2)", () => {
  // Helpers below extract the JSON payload tunnelled through the mocked
  // textResult — see the api.js mock at the top of the file.
  function payloadOf(result: any): any {
    return JSON.parse(result.content[0].text);
  }

  it("manage_files delete (jellyfinItemId) without token returns a confirm handle, no destruction", async () => {
    vi.mocked(jfApi).mockResolvedValueOnce({
      Items: [{ Id: "abc", Name: "The Show", Type: "Series", Path: "/data/anime/The Show" }],
    });
    const tools = loadLibraryTools();
    const handler = tools.get("manage_files")!.handler;

    const result = await handler({ action: "delete", jellyfinItemId: "abc" });
    const body = payloadOf(result);

    expect(body.requiresConfirmation).toBe(true);
    expect(body.confirmToken).toMatch(/^[a-f0-9]{24}$/);
    expect(body.preview).toMatchObject({ kind: "jellyfin", id: "abc", name: "The Show" });
    // jfApi was called for the lookup but NOT for DELETE — no destruction.
    expect(jfApi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jfApi).mock.calls[0][0]).toContain("/Items?ids=abc");
    expect(vi.mocked(sonarrApi)).not.toHaveBeenCalled();
    expect(vi.mocked(radarrApi)).not.toHaveBeenCalled();
  });

  it("manage_files delete with bogus confirmToken rejects (no destruction)", async () => {
    const tools = loadLibraryTools();
    const handler = tools.get("manage_files")!.handler;

    await expect(
      handler({ action: "delete", jellyfinItemId: "abc", confirmToken: "deadbeefdeadbeefdeadbeef" }),
    ).rejects.toThrow(/Invalid or expired confirmToken/);

    // We rejected without ever talking to Jellyfin.
    expect(jfApi).not.toHaveBeenCalled();
  });

  it("cleanup_server dryRun=false without token returns a confirm handle, did NOT delete anything", async () => {
    vi.mocked(sonarrApi).mockResolvedValue([]);
    vi.mocked(radarrApi).mockResolvedValue([]);
    const tools = loadMaintenanceTools();
    const handler = tools.get("cleanup_server")!.handler;

    const result = await handler({ dryRun: false });
    const body = payloadOf(result);

    expect(body.requiresConfirmation).toBe(true);
    expect(body.confirmToken).toMatch(/^[a-f0-9]{24}$/);
    expect(body.mode).toBe("DRY RUN (no changes)");
    // sonarrApi was queried for ghost detection (read-only); no DELETE call.
    expect(vi.mocked(sonarrApi).mock.calls.every(([ep]) => !String(ep).startsWith("series/") || !String(ep).includes("DELETE")))
      .toBe(true);
  });

  it("cleanup_server dryRun=false with bogus token rejects", async () => {
    const tools = loadMaintenanceTools();
    const handler = tools.get("cleanup_server")!.handler;

    await expect(handler({ dryRun: false, confirmToken: "bogus" })).rejects.toThrow(
      /Invalid or expired confirmToken/,
    );
  });

  it("manage_files delete (jellyfinItemId) accepts a freshly-issued token and proceeds", async () => {
    // First call (no token) issues the token + builds the preview.
    vi.mocked(jfApi).mockResolvedValueOnce({
      Items: [{ Id: "abc", Name: "The Show", Type: "Series", Path: "/data/anime/The Show" }],
    });
    const tools = loadLibraryTools();
    const handler = tools.get("manage_files")!.handler;

    const previewResult = await handler({ action: "delete", jellyfinItemId: "abc" });
    const { confirmToken } = payloadOf(previewResult);

    // Second call: same target + the issued token. Lookup happens again and
    // then DELETE goes through. We mock both jfApi calls + the cleanup loop.
    vi.mocked(jfApi).mockResolvedValueOnce({
      Items: [{ Id: "abc", Name: "The Show", Type: "Series", Path: "/data/anime/The Show" }],
    });
    vi.mocked(jfApi).mockResolvedValueOnce({}); // DELETE
    vi.mocked(sonarrApi).mockResolvedValueOnce([]); // series list (no match → no DELETE)
    vi.mocked(jfApi).mockResolvedValueOnce({}); // /Library/Refresh

    const applyResult = await handler({
      action: "delete",
      jellyfinItemId: "abc",
      confirmToken,
    });
    const body = payloadOf(applyResult);

    expect(body.message).toMatch(/Deleted "The Show"/);
    expect(body.requiresConfirmation).toBeUndefined();

    // Re-using the same token must fail (single-use).
    await expect(
      handler({ action: "delete", jellyfinItemId: "abc", confirmToken }),
    ).rejects.toThrow(/Invalid or expired confirmToken/);
  });
});
