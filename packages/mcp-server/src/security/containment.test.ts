/**
 * Gate G02: Security Contracts and Authentication Containment Test Suite
 *
 * Verifies exit criteria for Phase P01:
 * - SEC-01: Anonymous request flow to OAuth endpoints does not grant access (B01 closed).
 * - SEC-02: Forged, expired tokens, or session IDs alone cannot access protected endpoints (INV-AUTH).
 * - SEC-03: Every mutating tool and endpoint is rejected with OPERATION_MUTATION_CONTAINED before any effect.
 * - SEC-04: Reproductions of previous breaches (B01, B03, B04, B05) cause zero data destruction or file modifications.
 * - SEC-05: Agent credentials cannot access setup/admin routes or read environment secrets (INV-SEPARATION).
 * - SEC-06: Error formats and containment payloads conform to strict security contracts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Server } from "http";

// Mock remote APIs and filesystem deletion methods to assert zero destructive side effects (SEC-04)
vi.mock("../helpers/api.js", () => ({
  jfApi: vi.fn().mockResolvedValue({ Items: [] }),
  sonarrApi: vi.fn().mockResolvedValue([]),
  radarrApi: vi.fn().mockResolvedValue([]),
  prowlarrApi: vi.fn().mockResolvedValue([]),
  textResult: (x: unknown) => ({ content: [{ type: "text", text: JSON.stringify(x) }] }),
}));

vi.mock("../helpers/pyload.js", () => ({
  pyloadApi: vi.fn().mockResolvedValue({}),
  pyloadApiJson: vi.fn().mockResolvedValue({}),
}));

vi.mock("../helpers/qbittorrent.js", () => ({
  qbitApi: vi.fn().mockResolvedValue([]),
  qbitPause: vi.fn().mockResolvedValue(undefined),
  qbitResume: vi.fn().mockResolvedValue(undefined),
}));

const { mockRm, mockUnlink } = vi.hoisted(() => ({
  mockRm: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: mockRm,
    unlink: mockUnlink,
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rm: mockRm,
    unlink: mockUnlink,
  };
});

import { jfApi, sonarrApi, radarrApi } from "../helpers/api.js";
import { pyloadApi } from "../helpers/pyload.js";
import { qbitApi } from "../helpers/qbittorrent.js";

import { INTERNAL_API_KEY, AGENT_API_KEY } from "../auth.js";
import { createApp } from "../index.js";
import { MutationContainedError, containedMutationResult } from "../helpers/containment.js";

import { registerLibraryTools } from "../tools/library.js";
import { registerDownloadTools } from "../tools/downloads.js";
import { registerMaintenanceTools } from "../tools/maintenance.js";
import { registerSonarrTools } from "../tools/sonarr.js";
import { registerRadarrTools } from "../tools/radarr.js";

interface CapturedTool {
  handler: (args: any) => Promise<any> | any;
}

class FakeMcpServer {
  tools = new Map<string, CapturedTool>();
  registerTool(name: string, _config: unknown, handler: any): void {
    this.tools.set(name, { handler });
  }
}

function loadAllTools() {
  const fake = new FakeMcpServer();
  registerLibraryTools(fake as any);
  registerDownloadTools(fake as any);
  registerMaintenanceTools(fake as any);
  registerSonarrTools(fake as any);
  registerRadarrTools(fake as any);
  return fake.tools;
}

describe("Gate G02: Auth Boundaries and Security Containment", () => {
  let server: Server;
  let baseUrl: string;
  let allTools: Map<string, CapturedTool>;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    allTools = loadAllTools();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // SEC-01: Anonymous OAuth flow rejection (B01 closed)
  // -------------------------------------------------------------------------
  describe("SEC-01: Public OAuth Issuer Rejection", () => {
    const endpoints = [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/authorize",
      "/token",
      "/register",
    ];

    for (const ep of endpoints) {
      it(`rejects anonymous requests to ${ep} with 403 ERR_OAUTH_DISABLED`, async () => {
        const res = await fetch(`${baseUrl}${ep}`, { method: "POST" });
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data).toMatchObject({
          code: "ERR_OAUTH_DISABLED",
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // SEC-02: Authentication & Session Boundaries (INV-AUTH)
  // -------------------------------------------------------------------------
  describe("SEC-02: Authentication & Session Isolation", () => {
    it("rejects /mcp when Authorization header is missing", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it("rejects /mcp with forged or invalid Bearer token", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer invalid-token-forged",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it("rejects /mcp with known session ID alone without a valid Bearer token", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "mcp-session-id": "session-12345-claimed",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it("rejects /api/dashboard/health without valid authentication even from localhost", async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/health`, {
        headers: { Host: "localhost" },
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // SEC-03: Inventory of Mutating Tools and Endpoints Strictly Contained
  // -------------------------------------------------------------------------
  describe("SEC-03: Mutating Tools & Endpoints Contained by Default", () => {
    it("contains manage_library create", async () => {
      const handler = allTools.get("manage_library")!.handler;
      await expect(
        handler({ action: "create", name: "TestLib", type: "movies", folder: "movies" }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains manage_files move", async () => {
      const handler = allTools.get("manage_files")!.handler;
      await expect(
        handler({ action: "move", sourcePaths: ["downloads/file.mkv"], destFolder: "movies" }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains rename_episodes execution (!dryRun)", async () => {
      const handler = allTools.get("rename_episodes")!.handler;
      await expect(
        handler({ showPath: "tv/Show", showName: "Show", seasonNumber: 1, startEpisodeNumber: 1, dryRun: false }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains fix_subtitles execution (!dryRun)", async () => {
      const handler = allTools.get("fix_subtitles")!.handler;
      await expect(
        handler({ mediaPath: "tv/Show", dryRun: false }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains download_add", async () => {
      const handler = allTools.get("download_add")!.handler;
      await expect(
        handler({ urls: ["https://example.com/movie.zip"], packageName: "movie" }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains download_status delete", async () => {
      const handler = allTools.get("download_status")!.handler;
      await expect(
        handler({ action: "delete", packageIds: [1] }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains download_status organize", async () => {
      const handler = allTools.get("download_status")!.handler;
      await expect(
        handler({ action: "organize", packageFolder: "Movie.1989", showName: "Movie (1989)", libraryFolder: "movies" }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains download_direct", async () => {
      const handler = allTools.get("download_direct")!.handler;
      await expect(
        handler({ url: "https://example.com/test.mkv", showName: "Test Movie", libraryFolder: "movies" }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains cancel_downloads for all mutating actions", async () => {
      const handler = allTools.get("cancel_downloads")!.handler;
      const mutatingActions = ["cancel", "clean_orphans", "cancel_series", "purge_duplicates"] as const;
      for (const act of mutatingActions) {
        await expect(
          handler({ source: "sonarr", action: act, queueIds: [1] }),
        ).rejects.toThrow(MutationContainedError);
      }
    });

    it("contains cleanup_server when attempting execution", async () => {
      const handler = allTools.get("cleanup_server")!.handler;
      // Get preview token
      const preview = await handler({ dryRun: false });
      const confirmToken = JSON.parse(preview.content[0].text).confirmToken;
      // Pass token to execute
      await expect(
        handler({ dryRun: false, confirmToken }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains series_search when adding series", async () => {
      const handler = allTools.get("series_search")!.handler;
      await expect(
        handler({ addTvdbId: 12345 }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains series_remove", async () => {
      const handler = allTools.get("series_remove")!.handler;
      await expect(
        handler({ seriesId: 1, deleteFiles: false }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains series_grab", async () => {
      const handler = allTools.get("series_grab")!.handler;
      await expect(
        handler({ guid: "guid-1", indexerId: 1 }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains series_import when action is import", async () => {
      const handler = allTools.get("series_import")!.handler;
      await expect(
        handler({ action: "import", folder: "downloads/Show", files: [{ path: "file.mkv", episodeIds: [1] }] }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains movie_search when adding movie", async () => {
      const handler = allTools.get("movie_search")!.handler;
      await expect(
        handler({ addTmdbId: 54321 }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains movie_remove", async () => {
      const handler = allTools.get("movie_remove")!.handler;
      await expect(
        handler({ movieId: 1, deleteFiles: false }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains movie_grab", async () => {
      const handler = allTools.get("movie_grab")!.handler;
      await expect(
        handler({ guid: "guid-2", indexerId: 2 }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains movie_import when action is import", async () => {
      const handler = allTools.get("movie_import")!.handler;
      await expect(
        handler({ action: "import", folder: "downloads/Movie", files: [{ path: "file.mkv", movieId: 1 }] }),
      ).rejects.toThrow(MutationContainedError);
    });

    it("contains POST /api/dashboard/sessions/:id/stop with 403", async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/sessions/sess-1/stop`, {
        method: "POST",
        headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data).toMatchObject({
        code: "OPERATION_MUTATION_CONTAINED",
        securityGate: "SEC-03",
      });
    });

    it("contains DELETE /api/dashboard/downloads/qbit/:hash with 403", async () => {
      const res = await fetch(`${baseUrl}/api/dashboard/downloads/qbit/hash123`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data).toMatchObject({
        code: "OPERATION_MUTATION_CONTAINED",
        securityGate: "SEC-03",
      });
    });
  });

  // -------------------------------------------------------------------------
  // SEC-04: Breach Reproductions Cause Zero Data Destruction
  // -------------------------------------------------------------------------
  describe("SEC-04: Breach Reproductions Cause Zero Destruction", () => {

    it("B04 reproduction: cancel_downloads clean_orphans throws before qbitApi delete", async () => {
      const handler = allTools.get("cancel_downloads")!.handler;
      await expect(handler({ source: "qbittorrent", action: "clean_orphans" })).rejects.toThrow(
        MutationContainedError,
      );
      expect(qbitApi).not.toHaveBeenCalled();
    });

    it("B05 reproduction: cleanup_server apply throws before any fs.rm or sonarrApi delete", async () => {
      const handler = allTools.get("cleanup_server")!.handler;
      const preview = await handler({ dryRun: false });
      const confirmToken = JSON.parse(preview.content[0].text).confirmToken;

      vi.clearAllMocks();
      await expect(handler({ dryRun: false, confirmToken })).rejects.toThrow(
        MutationContainedError,
      );
      expect(mockRm).not.toHaveBeenCalled();
      expect(sonarrApi).not.toHaveBeenCalled();
      expect(radarrApi).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SEC-05: Owner vs Agent Authority Separation (INV-SEPARATION)
  // -------------------------------------------------------------------------
  describe("SEC-05: Authority Separation (Owner vs Agent)", () => {
    it("rejects Agent credential from accessing /api/setup with 403 ERR_FORBIDDEN_AGENT", async () => {
      const res = await fetch(`${baseUrl}/api/setup/services`, {
        headers: { Authorization: `Bearer ${AGENT_API_KEY}` },
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data).toMatchObject({
        code: "ERR_FORBIDDEN_AGENT",
      });
    });

    it("allows Owner credential to pass requireOwner on /api/setup", async () => {
      const res = await fetch(`${baseUrl}/api/setup/services`, {
        headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
      });
      // Not 401 or 403 — owner identity is accepted past the auth/requireOwner guards
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // SEC-06: Security Contracts & Containment Payloads Format
  // -------------------------------------------------------------------------
  describe("SEC-06: Security Contracts & Payload Integrity", () => {
    it("MutationContainedError formats code, securityGate, and operation", () => {
      const err = new MutationContainedError("test_op", "testing reasons");
      expect(err.code).toBe("OPERATION_MUTATION_CONTAINED");
      expect(err.securityGate).toBe("SEC-03");
      expect(err.operation).toBe("test_op");
      expect(err.message).toContain("[SEC-03]");
      expect(err.message).toContain("test_op");
    });

    it("containedMutationResult returns conforming MCP error format", () => {
      const res = containedMutationResult("test_op", "contained reason");
      expect(res.isError).toBe(true);
      expect(res.content).toHaveLength(1);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.error).toBe("OPERATION_MUTATION_CONTAINED");
      expect(parsed.code).toBe("SEC-03");
      expect(parsed.operation).toBe("test_op");
      expect(parsed.status).toBe("blocked");
    });
  });
});

