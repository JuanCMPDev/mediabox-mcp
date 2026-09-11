/**
 * Gate G06 additions: cursors page over a stable snapshot bound to the
 * principal, budgets apply to real tool calls, envelopes are bounded and
 * surfaced as structuredContent, and partial upstreams stay distinguishable.
 */
import { describe, it, expect } from "vitest";
import { searchCatalog, type CatalogDeps } from "./catalog.js";
import { QueryCache } from "./cache.js";
import { QueryBudgetTracker, BudgetExhaustedError } from "./budgets.js";
import { CursorValidationError } from "./pagination.js";
import { createToolEnvelope, createErrorEnvelope, envelopeToolResult, boundEnvelope, DEFAULT_ENVELOPE_BYTE_LIMIT } from "./envelope.js";
import { verifyMediaRef } from "./references.js";
import type { ServiceQueryResult } from "./clients.js";

function ok<T>(source: string, data: T): ServiceQueryResult<T> {
  return { data, sourceStatus: { source, observedAt: new Date().toISOString(), completeness: "complete" } };
}

function unavailable<T>(source: string): ServiceQueryResult<T> {
  return {
    data: null,
    sourceStatus: { source, observedAt: new Date().toISOString(), completeness: "unavailable", error: { code: "ERR_UPSTREAM_UNAVAILABLE", message: "down" } },
  };
}

function makeDeps(movieCount: number, seriesCount: number) {
  let calls = 0;
  const deps: CatalogDeps = {
    sonarrLookup: async () => {
      calls += 1;
      return ok("sonarr", Array.from({ length: seriesCount }, (_, i) => ({ title: `Show ${i}`, year: 2000 + i, tvdbId: 1000 + i })));
    },
    radarrLookup: async () => {
      calls += 1;
      return ok("radarr", Array.from({ length: movieCount }, (_, i) => ({ title: `Film ${i}`, year: 1990 + i, tmdbId: 500 + i, id: i + 1, hasFile: true })));
    },
    cache: new QueryCache(),
  };
  return { deps, calls: () => calls };
}

const context = { installationId: "inst_a", ownerId: "owner-ui", conversationId: "conv_1", principalId: "agent-a" };

describe("Catalog cursors and snapshots (QRY-01 / QRY-04 / QRY-05)", () => {
  it("pages over one stable snapshot without re-querying upstream", async () => {
    const { deps, calls } = makeDeps(25, 0);
    const first = await searchCatalog({ query: "film", type: "movie", pageSize: 10 }, { ...context }, deps);
    expect(first.status).toBe("ok");
    expect(first.data).toHaveLength(10);
    expect(first.page?.hasMore).toBe(true);
    expect(first.page?.totalItems).toBe(25);
    expect(first.data[0].mediaRef.startsWith("mref_")).toBe(true);

    const second = await searchCatalog({ query: "film", type: "movie", pageSize: 10, cursor: first.page!.cursor }, { ...context }, deps);
    expect(second.data.map((m) => m.title)).toEqual(Array.from({ length: 10 }, (_, i) => `Film ${i + 10}`));
    const third = await searchCatalog({ query: "film", type: "movie", pageSize: 10, cursor: second.page!.cursor }, { ...context }, deps);
    expect(third.data).toHaveLength(5);
    expect(third.page?.hasMore).toBe(false);
    expect(calls()).toBe(1);
  });

  it("rejects cursors from another principal, tampered cursors and expired snapshots", async () => {
    const { deps } = makeDeps(15, 0);
    const first = await searchCatalog({ query: "film", type: "movie", pageSize: 10 }, { ...context }, deps);
    const cursor = first.page!.cursor!;

    await expect(searchCatalog({ query: "film", type: "movie", pageSize: 10, cursor }, { ...context, principalId: "agent-b" }, deps)).rejects.toMatchObject({ code: "ERR_CURSOR_MISMATCH" });
    await expect(searchCatalog({ query: "other", type: "movie", pageSize: 10, cursor }, { ...context }, deps)).rejects.toMatchObject({ code: "ERR_CURSOR_MISMATCH" });
    await expect(searchCatalog({ query: "film", type: "movie", pageSize: 10, cursor: cursor.slice(0, -4) + "0000" }, { ...context }, deps)).rejects.toMatchObject({ code: "ERR_INVALID_CURSOR" });

    deps.cache!.clear();
    await expect(searchCatalog({ query: "film", type: "movie", pageSize: 10, cursor }, { ...context }, deps)).rejects.toMatchObject({ code: "ERR_EXPIRED_CURSOR" });
  });

  it("charges the per-turn page budget and stops at the limit (QRY-06)", async () => {
    const { deps } = makeDeps(50, 0);
    const budget = new QueryBudgetTracker({ maxPages: 3 });
    const p1 = await searchCatalog({ query: "film", type: "movie", pageSize: 10 }, { ...context, budget }, deps);
    const p2 = await searchCatalog({ query: "film", type: "movie", pageSize: 10, cursor: p1.page!.cursor }, { ...context, budget }, deps);
    await searchCatalog({ query: "film", type: "movie", pageSize: 10, cursor: p2.page!.cursor }, { ...context, budget }, deps);
    await expect(searchCatalog({ query: "film", type: "movie", pageSize: 10 }, { ...context, budget }, deps)).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it("keeps a partial upstream distinguishable from an empty result (QRY-03)", async () => {
    const deps: CatalogDeps = {
      sonarrLookup: async () => unavailable("sonarr"),
      radarrLookup: async () => ok("radarr", [{ title: "Only Film", year: 2001, tmdbId: 7 }]),
      cache: new QueryCache(),
    };
    const env = await searchCatalog({ query: "x", type: "all" }, { ...context }, deps);
    expect(env.status).toBe("partial");
    expect(env.data).toHaveLength(1);
    expect(env.sources.find((s) => s.source === "sonarr")?.completeness).toBe("unavailable");
    expect(env.sources.find((s) => s.source === "radarr")?.completeness).toBe("complete");
  });

  it("binds mediaRefs to the installation and owner of the session (CAT-02)", async () => {
    const { deps } = makeDeps(1, 0);
    const env = await searchCatalog({ query: "film", type: "movie" }, { ...context }, deps);
    const ref = env.data[0].mediaRef;
    expect(verifyMediaRef(ref, { installationId: "inst_a", ownerId: "owner-ui" }).id).toBe("movie:tmdb:500");
    expect(() => verifyMediaRef(ref, { installationId: "inst_b", ownerId: "owner-ui" })).toThrowError(/installation/);
    expect(verifyMediaRef(ref, { installationId: "inst_a", ownerId: "owner-ui" }).serviceEntityIds?.service).toBe("radarr");
  });
});

describe("Envelope tool results (QRY-02 / Blueprint 4.4)", () => {
  it("bounds oversized envelopes to the byte limit while keeping JSON valid and exposes structuredContent", () => {
    const data = Array.from({ length: 200 }, (_, i) => ({ title: `Título ${i} 🎬`, overview: "é😀".repeat(2000) }));
    const envelope = createToolEnvelope({ data, budget: { itemsReturned: data.length } });
    const result = envelopeToolResult(envelope);

    expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThanOrEqual(DEFAULT_ENVELOPE_BYTE_LIMIT);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(result.structuredContent);
    expect(parsed.budget.truncatedFields.length).toBeGreaterThan(0);
    expect(parsed.budget.bytesUsed).toBeLessThanOrEqual(DEFAULT_ENVELOPE_BYTE_LIMIT);
    expect(result.isError).toBeUndefined();
    // The caller's envelope is not mutated.
    expect(envelope.data).toHaveLength(200);
  });

  it("marks error envelopes with isError and keeps the code", () => {
    const result = envelopeToolResult(createErrorEnvelope({ code: "ERR_EXPIRED_REFERENCE", message: "expired" }));
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe("ERR_EXPIRED_REFERENCE");
  });

  it("never emits a lone surrogate when cutting strings", () => {
    const bounded = boundEnvelope(createToolEnvelope({ data: { s: "😀".repeat(5000) } }), 512);
    expect(bounded.truncated).toBe(true);
    expect(() => JSON.parse(bounded.json)).not.toThrow();
    expect(bounded.json).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
