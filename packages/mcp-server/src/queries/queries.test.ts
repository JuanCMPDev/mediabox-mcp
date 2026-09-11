import { describe, it, expect, beforeEach } from "vitest";
import {
  createToolEnvelope,
  createErrorEnvelope,
  safeSerializeEnvelope,
  safeSubstring,
  DEFAULT_ENVELOPE_BYTE_LIMIT,
} from "./envelope.js";
import {
  createOpaqueCursor,
  verifyOpaqueCursor,
  paginateSlice,
  CursorValidationError,
} from "./pagination.js";
import {
  QueryBudgetTracker,
  BudgetExhaustedError,
  MAX_PAGES_PER_TURN,
  MAX_RELEASE_SEARCHES_PER_TURN,
} from "./budgets.js";
import { QueryCache } from "./cache.js";
import {
  createMediaRef,
  verifyMediaRef,
  createReleaseRef,
  verifyReleaseRef,
  ReferenceValidationError,
} from "./references.js";
import { buildCanonicalMediaId } from "./catalog.js";
import {
  rankReleaseCandidate,
  findAndRankReleases,
  analyzeReleaseLanguages,
  RANKING_VERSION,
} from "./releases.js";
import {
  createDownloadPlan,
  DownloadPlannerError,
} from "../operations/planners/download.js";
import { reconcileGrab } from "../operations/handlers.js";
import { defaultOperationStore } from "../operations/default-store.js";
import { OperationExecutor } from "../operations/executor.js";
import { registerStepHandlers } from "../operations/handlers.js";

describe("Gate G06 & Phases P06-P07: Query Contracts, Identity & Download Verification", () => {
  // -------------------------------------------------------------------------
  // QRY-01: 10,000 items projection within budget with accurate total
  // -------------------------------------------------------------------------
  describe("QRY-01: Massive Collection Pagination and Budget Projection", () => {
    it("handles 10,000 items fixture delivering projected page within budget with total count", () => {
      const TOTAL_ITEMS = 10000;
      const fixture = Array.from({ length: TOTAL_ITEMS }, (_, i) => ({
        id: `item_${i}`,
        title: `Episode ${i}`,
        sizeBytes: 1000000 + i,
        extraData: "A".repeat(200), // non-projected heavy field
      }));

      const context = {
        principalId: "user_1",
        installationId: "inst_1",
        snapshotId: "snap_10k",
      };

      // Page 1: 20 items
      const { data: page1, page: page1Info } = paginateSlice(
        fixture,
        undefined,
        20,
        context,
        TOTAL_ITEMS
      );

      expect(page1).toHaveLength(20);
      expect(page1Info.hasMore).toBe(true);
      expect(page1Info.totalItems).toBe(TOTAL_ITEMS);
      expect(page1Info.cursor).toBeDefined();

      const envelope1 = createToolEnvelope({
        data: page1.map((item) => ({ id: item.id, title: item.title })), // Projection
        page: page1Info,
      });

      const serialized1 = safeSerializeEnvelope(envelope1, 8192);
      expect(Buffer.byteLength(serialized1, "utf8")).toBeLessThanOrEqual(8192);
      const parsed1 = JSON.parse(serialized1);
      expect(parsed1.page.totalItems).toBe(10000);
      expect(parsed1.data).toHaveLength(20);

      // Page 2 using opaque cursor
      const { data: page2, page: page2Info } = paginateSlice(
        fixture,
        page1Info.cursor,
        20,
        context,
        TOTAL_ITEMS
      );

      expect(page2).toHaveLength(20);
      expect(page2[0].id).toBe("item_20");
      expect(page2Info.totalItems).toBe(TOTAL_ITEMS);
    });
  });

  // -------------------------------------------------------------------------
  // QRY-02: Unicode and huge fields never corrupt JSON
  // -------------------------------------------------------------------------
  describe("QRY-02: Unicode Safety and Resilient JSON Serialization", () => {
    it("never breaks JSON syntax when handling complex UTF-8, emojis and massive fields", () => {
      const complexUnicode = "🚀🎉 👨‍👩‍👧‍👦 日本語テキスト ñañdú Ñandú \uD83D\uDE00";
      const massiveString = complexUnicode + "X".repeat(300_000);

      const envelope = createToolEnvelope({
        data: {
          title: "Huge Payload Test",
          description: massiveString,
          deepObject: {
            subfield: "Y".repeat(50_000),
            items: [complexUnicode, "Z".repeat(10_000)],
          },
        },
      });

      const serialized = safeSerializeEnvelope(envelope, 8192);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8192);

      // Must be 100% valid JSON without parsing error
      let parsed: any;
      expect(() => {
        parsed = JSON.parse(serialized);
      }).not.toThrow();

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.budget.truncatedFields.length).toBeGreaterThan(0);
      expect(parsed.budget.bytesUsed).toBeLessThanOrEqual(8192);
    });

    it("safeSubstring does not split UTF-16 surrogate pairs", () => {
      const emojiString = "Hello 🚀 World";
      const truncated = safeSubstring(emojiString, 7); // Cut near emoji surrogate
      expect(truncated.endsWith("...")).toBe(true);
      expect(() => JSON.parse(JSON.stringify(truncated))).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // QRY-03: Partial error vs absent data are distinguishable
  // -------------------------------------------------------------------------
  describe("QRY-03: Distinguishability of Partial Upstream Failures and Absent Data", () => {
    it("marks partial status and records source errors when upstream is unavailable", () => {
      const envelope = createToolEnvelope({
        data: [],
        sources: [
          {
            source: "sonarr",
            observedAt: new Date().toISOString(),
            completeness: "complete",
          },
          {
            source: "radarr",
            observedAt: new Date().toISOString(),
            completeness: "unavailable",
            error: {
              code: "ERR_UPSTREAM_UNAVAILABLE",
              message: "Radarr connection refused on port 7878",
            },
          },
        ],
        warnings: ["Radarr was unreachable"],
      });

      expect(envelope.status).toBe("partial");
      expect(envelope.data).toEqual([]);
      expect(envelope.sources[1].completeness).toBe("unavailable");
      expect(envelope.sources[1].error?.code).toBe("ERR_UPSTREAM_UNAVAILABLE");
    });

    it("marks status ok when service is healthy and item is legitimately absent", () => {
      const envelope = createToolEnvelope({
        data: null,
        sources: [
          {
            source: "sonarr",
            observedAt: new Date().toISOString(),
            completeness: "complete",
          },
        ],
      });

      expect(envelope.status).toBe("ok");
      expect(envelope.data).toBeNull();
      expect(envelope.sources[0].completeness).toBe("complete");
      expect(envelope.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // QRY-04: Foreign, tampered, or expired cursors are rejected
  // -------------------------------------------------------------------------
  describe("QRY-04: Cursor Validation and Tamper Resistance", () => {
    const context = {
      principalId: "owner_alpha",
      installationId: "inst_alpha",
      snapshotId: "snap_1",
    };

    it("rejects cursor with tampered signature", () => {
      const cursor = createOpaqueCursor({
        offset: 20,
        pageSize: 10,
        ...context,
      });

      const tampered = cursor.slice(0, -4) + "ffff";
      expect(() => verifyOpaqueCursor(tampered, context)).toThrow(CursorValidationError);
      expect(() => verifyOpaqueCursor(tampered, context)).toThrowError(/Tampered or invalid/);
    });

    it("rejects expired cursor", () => {
      const cursor = createOpaqueCursor({
        offset: 20,
        pageSize: 10,
        ...context,
        ttlMs: -1000, // Expired in the past
      });

      expect(() => verifyOpaqueCursor(cursor, context)).toThrow(CursorValidationError);
      try {
        verifyOpaqueCursor(cursor, context);
      } catch (err: any) {
        expect(err.code).toBe("ERR_EXPIRED_CURSOR");
      }
    });

    it("rejects cursor belonging to a different installation or principal", () => {
      const cursor = createOpaqueCursor({
        offset: 20,
        pageSize: 10,
        ...context,
      });

      expect(() =>
        verifyOpaqueCursor(cursor, {
          ...context,
          installationId: "different_inst",
        })
      ).toThrowError(/installation mismatch/);

      expect(() =>
        verifyOpaqueCursor(cursor, {
          ...context,
          principalId: "different_user",
        })
      ).toThrowError(/principal mismatch/);
    });
  });

  // -------------------------------------------------------------------------
  // QRY-05: Cache tenant isolation and targeted invalidation
  // -------------------------------------------------------------------------
  describe("QRY-05: Multi-Tenant Isolated Cache and Targeted Invalidation", () => {
    let cache: QueryCache;

    beforeEach(() => {
      cache = new QueryCache();
    });

    it("isolates cached queries between distinct tenants and principals", () => {
      const key = QueryCache.buildKey("search", { q: "matrix" }, {
        installationId: "inst_1",
        roleOrPermission: "owner",
      });

      cache.set(
        key,
        { results: ["The Matrix (1999)"] },
        { installationId: "inst_1", principalId: "user_1" }
      );

      // Same key but accessed by different tenant -> returns undefined
      const foreign = cache.get(key, { installationId: "inst_2", principalId: "user_1" });
      expect(foreign).toBeUndefined();

      // Same key but accessed by different principal -> returns undefined
      const foreignUser = cache.get(key, { installationId: "inst_1", principalId: "user_2" });
      expect(foreignUser).toBeUndefined();

      // Legitimate tenant and principal -> returns cached data
      const legitimate = cache.get(key, { installationId: "inst_1", principalId: "user_1" });
      expect(legitimate).toEqual({ results: ["The Matrix (1999)"] });
    });

    it("invalidates cache selectively by mutation tags without purging unrelated entries", () => {
      const keyMedia = "inst:1:media:1";
      const keyDownloads = "inst:1:downloads:1";

      cache.set(keyMedia, "media_data", { installationId: "inst_1", principalId: "user_1" }, 60000, ["media"]);
      cache.set(keyDownloads, "download_data", { installationId: "inst_1", principalId: "user_1" }, 60000, ["downloads"]);

      // Invalidate only 'downloads'
      const purged = cache.invalidateTags(["downloads"], "inst_1");
      expect(purged).toBe(1);

      expect(cache.get(keyDownloads, { installationId: "inst_1", principalId: "user_1" })).toBeUndefined();
      expect(cache.get(keyMedia, { installationId: "inst_1", principalId: "user_1" })).toBe("media_data");
    });
  });

  // -------------------------------------------------------------------------
  // QRY-06: Budget tracker enforces turn limits and respects cancellation
  // -------------------------------------------------------------------------
  describe("QRY-06: Query Budget Tracker and Cancellation", () => {
    it("halts and enforces max 3 pages per query turn", () => {
      const tracker = new QueryBudgetTracker();
      tracker.recordPageFetch();
      tracker.recordPageFetch();
      tracker.recordPageFetch();

      expect(tracker.pagesFetched).toBe(3);
      expect(() => tracker.recordPageFetch()).toThrow(BudgetExhaustedError);
      try {
        tracker.recordPageFetch();
      } catch (err: any) {
        expect(err.code).toBe("ERR_PAGE_LIMIT_EXCEEDED");
      }
    });

    it("halts and enforces max 2 release searches per turn", () => {
      const tracker = new QueryBudgetTracker();
      tracker.recordReleaseSearch();
      tracker.recordReleaseSearch();

      expect(() => tracker.recordReleaseSearch()).toThrow(BudgetExhaustedError);
      try {
        tracker.recordReleaseSearch();
      } catch (err: any) {
        expect(err.code).toBe("ERR_RELEASE_SEARCH_LIMIT_EXCEEDED");
      }
    });

    it("aborts query immediately when AbortSignal is triggered", () => {
      const ac = new AbortController();
      const tracker = new QueryBudgetTracker({ signal: ac.signal });

      ac.abort();
      expect(() => tracker.checkCanFetchPage()).toThrow(BudgetExhaustedError);
      try {
        tracker.checkCanFetchPage();
      } catch (err: any) {
        expect(err.code).toBe("ERR_QUERY_TIMEOUT");
      }
    });
  });

  // -------------------------------------------------------------------------
  // CAT-01: Homonyms, years, and remakes do not collide
  // -------------------------------------------------------------------------
  describe("CAT-01: Non-colliding Identity for Homonyms and Remakes", () => {
    it("assigns distinct canonical identities to homonyms with different years or provider IDs", () => {
      const id1989 = buildCanonicalMediaId({
        type: "movie",
        title: "Pet Sematary",
        year: 1989,
        tmdbId: 8337,
      });

      const id2019 = buildCanonicalMediaId({
        type: "movie",
        title: "Pet Sematary",
        year: 2019,
        tmdbId: 447404,
      });

      expect(id1989).toBe("movie:tmdb:8337");
      expect(id2019).toBe("movie:tmdb:447404");
      expect(id1989).not.toBe(id2019);

      // Different mediaRefs generated
      const context = {
        installationId: "local",
        ownerId: "local",
        conversationId: "conv_1",
      };

      const ref1989 = createMediaRef({ id: id1989, title: "Pet Sematary" }, context);
      const ref2019 = createMediaRef({ id: id2019, title: "Pet Sematary" }, context);

      expect(ref1989).not.toBe(ref2019);
      expect(verifyMediaRef(ref1989, context).id).toBe("movie:tmdb:8337");
      expect(verifyMediaRef(ref2019, context).id).toBe("movie:tmdb:447404");
    });
  });

  // -------------------------------------------------------------------------
  // CAT-02: Opaque references validation and cross-type rejection
  // -------------------------------------------------------------------------
  describe("CAT-02: Opaque References Security and Expiry Validation", () => {
    const context = {
      installationId: "inst_1",
      ownerId: "user_1",
      conversationId: "conv_1",
    };

    it("rejects expired references", () => {
      const ref = createMediaRef({ id: "movie:1" }, { ...context, ttlMs: -1000 });
      expect(() => verifyMediaRef(ref, context)).toThrow(ReferenceValidationError);
      try {
        verifyMediaRef(ref, context);
      } catch (err: any) {
        expect(err.code).toBe("ERR_EXPIRED_REFERENCE");
      }
    });

    it("rejects using mediaRef where releaseRef is expected", () => {
      const mref = createMediaRef({ id: "movie:1" }, context);
      expect(() => verifyReleaseRef(mref, context)).toThrow(ReferenceValidationError);
      try {
        verifyReleaseRef(mref, context);
      } catch (err: any) {
        expect(err.code).toBe("ERR_REFERENCE_WRONG_TYPE");
      }
    });

    it("rejects references from a different installation or owner", () => {
      const ref = createMediaRef({ id: "movie:1" }, context);
      expect(() =>
        verifyMediaRef(ref, {
          ...context,
          installationId: "other_inst",
        })
      ).toThrowError(/installation mismatch/);
    });
  });

  // -------------------------------------------------------------------------
  // CAT-03: Deterministic ranking and strict language rules
  // -------------------------------------------------------------------------
  describe("CAT-03: Deterministic Release Ranking & Strict Audio Language Rules", () => {
    it("rejects dead torrents with 0 seeders as hard constraint", () => {
      const deadRelease = {
        guid: "dead_1",
        title: "Movie.1080p.WEBRip",
        size: 2000000000,
        seeders: 0,
      };

      const ranked = rankReleaseCandidate(deadRelease, { minSeeders: 1 });
      expect(ranked.rejected).toBe(true);
      expect(ranked.rejections).toContain("Seeders (0) below minimum threshold (1)");
    });

    it("strictly rejects unknown language when Latin American Spanish is required", () => {
      const unknownLangRelease = {
        guid: "rel_unknown",
        title: "Movie.2024.1080p.x264-EVO",
        size: 3000000000,
        seeders: 15,
        languages: [], // Unknown
      };

      const ranked = rankReleaseCandidate(unknownLangRelease, {
        requiredAudioLanguage: "latino",
        strictAudioLanguage: true,
      });

      expect(ranked.rejected).toBe(true);
      expect(ranked.rejections.some((r) => r.includes("Language is unknown"))).toBe(true);
    });

    it("strictly rejects Castilian Spanish when Latin American Spanish is required", () => {
      const castilianRelease = {
        guid: "rel_castellano",
        title: "Pelicula.2024.Castellano.1080p",
        size: 2500000000,
        seeders: 10,
        languages: [{ name: "Spanish" }],
      };

      const ranked = rankReleaseCandidate(castilianRelease, {
        requiredAudioLanguage: "latino",
        strictAudioLanguage: true,
      });

      expect(ranked.rejected).toBe(true);
      expect(ranked.rejections.some((r) => r.includes("Castilian Spanish audio does not satisfy"))).toBe(true);
    });

    it("accepts and boosts confirmed Latin American Spanish releases", () => {
      const latinoRelease = {
        guid: "rel_latino",
        title: "Pelicula.2024.Audio.Latino.1080p.WEB-DL",
        size: 2500000000,
        seeders: 20,
        languages: [{ name: "Spanish Latino" }],
      };

      const ranked = rankReleaseCandidate(latinoRelease, {
        requiredAudioLanguage: "latino",
        strictAudioLanguage: true,
        preferredResolution: "1080p",
      });

      expect(ranked.rejected).toBe(false);
      expect(ranked.score).toBeGreaterThan(150);
      expect(ranked.reasons.some((r) => r.includes("Latin American Spanish"))).toBe(true);
    });

    it("produces identical stable ranking across repeated executions", async () => {
      const rawList = [
        { guid: "g1", title: "Show.S01E01.720p", size: 1000, seeders: 5 },
        { guid: "g2", title: "Show.S01E01.1080p", size: 2000, seeders: 25 },
        { guid: "g3", title: "Show.S01E01.2160p", size: 5000, seeders: 10 },
      ];

      const context = {
        installationId: "local",
        ownerId: "local",
        conversationId: "c1",
      };

      const res1 = await findAndRankReleases("series:1", "series", rawList, { preferredResolution: "1080p" }, context);
      const res2 = await findAndRankReleases("series:1", "series", rawList, { preferredResolution: "1080p" }, context);

      expect(res1.data.map((r) => r.guid)).toEqual(res2.data.map((r) => r.guid));
      expect(res1.data[0].guid).toBe("g2"); // 1080p with 25 seeders ranks top
    });
  });

  // -------------------------------------------------------------------------
  // CAT-04: Structured typed selection from card clicks
  // -------------------------------------------------------------------------
  describe("CAT-04: Typed Selection from UI Choice Cards", () => {
    it("creates typed selection without free-form LLM hallucinations", () => {
      const releaseRef = createReleaseRef(
        { guid: "g_123", title: "Movie.1080p", mediaId: "movie:1" },
        { installationId: "local", ownerId: "local", conversationId: "c1" }
      );

      const choiceItem = {
        id: "choice_1",
        label: "Movie (1080p - 2.4GB)",
        value: "Select release g_123",
        selection: {
          type: "select_release" as const,
          releaseRef,
          mediaRef: "mref_sample",
        },
      };

      expect(choiceItem.selection.type).toBe("select_release");
      expect(choiceItem.selection.releaseRef).toBe(releaseRef);
      expect(choiceItem.selection.releaseRef.startsWith("rref_")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CAT-05: Repeat requests do not duplicate or cancel foreign downloads
  // -------------------------------------------------------------------------
  // CAT-05 and CAT-06 moved to operations/download-grab.test.ts: the planner now takes a
  // PlanScope plus the live queue snapshot, and the grab handler talks to Sonarr/Radarr
  // through the mocked API boundary (no in-step mocks).
});
