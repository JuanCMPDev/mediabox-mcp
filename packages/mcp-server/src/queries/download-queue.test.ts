import { describe, expect, it, vi } from "vitest";
import { readDownloadQueue, type QueueReadDeps } from "./download-queue.js";
import { QueryBudgetTracker } from "./budgets.js";
import { envelopeToolResult } from "./envelope.js";

function fixture(): QueueReadDeps {
  return {
    sonarr: vi.fn(async () => ({ records: [{ id: 1, title: "Andor.S02E01", status: "downloading", size: 100, sizeleft: 25 }], totalRecords: 1 })),
    radarr: vi.fn(async () => ({ records: [{ id: 2, title: "Arrival.2016", status: "completed", size: 200, sizeleft: 0 }], totalRecords: 1 })),
    qbittorrent: vi.fn(async () => [{ hash: "a".repeat(40), name: "Andor.S02E01", state: "downloading", progress: 0.75 }]),
  };
}

describe("readDownloadQueue", () => {
  it("reads all queues in three bounded calls and preserves per-source counts/progress", async () => {
    const deps = fixture();
    const result = await readDownloadQueue({}, {}, deps);
    expect(result.status).toBe("ok");
    expect(result.sources.map((s) => [s.source, s.completeness])).toEqual([
      ["sonarr", "complete"], ["radarr", "complete"], ["qbittorrent", "complete"],
    ]);
    expect(result.data.queues.map((q) => [q.total, q.records?.[0].progressPercent])).toEqual([[1, 75], [1, 100], [null, 75]]);
    expect(result.page?.totalItems).toBeNull();
    for (const fn of Object.values(deps)) expect(fn).toHaveBeenCalledTimes(1);
    expect(deps.sonarr).toHaveBeenCalledWith(expect.stringContaining("page=1&pageSize=5"), expect.any(AbortSignal));
    expect(deps.qbittorrent).toHaveBeenCalledWith(expect.stringContaining("offset=0&limit=6"), expect.any(AbortSignal));
    expect(result.budget?.itemsReturned).toBe(3);
  });

  it("does not turn an unavailable client into an empty queue or expose its error body", async () => {
    const deps = fixture();
    deps.radarr = async () => { throw new Error("http://internal.example/api?apikey=SECRET-X"); };
    const result = await readDownloadQueue({}, {}, deps);
    expect(result.status).toBe("partial");
    expect(result.data.queues[1]).toMatchObject({ records: null, total: null, pagination: { hasMore: null, nextPage: null } });
    expect(result.sources[1]).toMatchObject({ completeness: "unavailable", error: { code: "ERR_UPSTREAM_UNAVAILABLE" } });
    expect(result.data.queues[0].records).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/SECRET-X|internal\.example/);
  });

  it("keeps a healthy empty queue distinguishable from malformed responses and absent totals", async () => {
    const deps = fixture();
    deps.sonarr = async () => ({ records: [], totalRecords: 0 });
    deps.radarr = async () => ({ records: [], totalRecords: undefined });
    deps.qbittorrent = async () => ({ status: 200 });
    const result = await readDownloadQueue({}, {}, deps);
    expect(result.data.queues[0]).toMatchObject({ records: [], total: 0, pagination: { hasMore: false } });
    expect(result.data.queues[1].total).toBeNull();
    expect(result.sources.map((s) => s.completeness)).toEqual(["complete", "partial", "unavailable"]);
    expect(result.data.queues[2].records).toBeNull();
  });

  it("uses upstream paging and one qBit lookahead without losing records between pages", async () => {
    const deps = fixture();
    const items = Array.from({ length: 7 }, (_, i) => ({ hash: String(i), name: `Torrent ${i}`, progress: 0.5, state: "stalledDL" }));
    deps.qbittorrent = vi.fn(async (endpoint) => {
      const params = new URLSearchParams(endpoint.split("?")[1]);
      const offset = Number(params.get("offset"));
      return items.slice(offset, offset + Number(params.get("limit")));
    });
    const first = await readDownloadQueue({ source: "qbittorrent", pageSize: 5 }, {}, deps);
    expect(first.data.queues[0].records?.map((r) => r.id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(first.data.queues[0].pagination).toMatchObject({ hasMore: true, nextPage: 2 });
    const second = await readDownloadQueue({ source: "qbittorrent", page: 2, pageSize: 5 }, {}, deps);
    expect(second.data.queues[0].records?.map((r) => r.id)).toEqual(["5", "6"]);
    expect(second.data.queues[0].pagination).toMatchObject({ hasMore: false, nextPage: null });
    expect(deps.sonarr).not.toHaveBeenCalled();
    expect(deps.radarr).not.toHaveBeenCalled();
  });

  it("keeps all 15 projected rows and metadata within 8 KiB even with hostile giant strings", async () => {
    const giant = "\u0001\\\"🚀".repeat(2000);
    const deps = fixture();
    const records = Array.from({ length: 5 }, (_, id) => ({ id, title: giant, status: giant, size: 100, sizeleft: 30, ignored: giant }));
    deps.sonarr = deps.radarr = async () => ({ records, totalRecords: 10000 });
    deps.qbittorrent = async () => Array.from({ length: 6 }, () => ({ hash: giant, name: giant, state: giant, progress: 0.3, ignored: giant }));
    const result = envelopeToolResult(await readDownloadQueue({}, {}, deps));
    const text = result.content[0].text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192);
    const envelope = JSON.parse(text);
    expect(envelope.data.queues.map((q: any) => q.records.length)).toEqual([5, 5, 5]);
    expect(envelope.budget.itemsReturned).toBe(15);
    expect(envelope.data.queues.every((q: any) => q.pagination.nextPage === 2)).toBe(true);
    expect(text).not.toContain("ignored");
  });

  it.each([{ source: "purge" }, { page: 0 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: 6 }, { action: "cancel" }])("rejects invalid input before dispatch: %j", async (input) => {
    const deps = fixture();
    await expect(readDownloadQueue(input as any, {}, deps)).rejects.toThrow();
    for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects an exhausted page budget and cancellation before dispatch", async () => {
    const deps = fixture();
    await expect(readDownloadQueue({}, { budget: new QueryBudgetTracker({ maxPages: 2 }) }, deps)).rejects.toMatchObject({ code: "ERR_PAGE_LIMIT_EXCEEDED" });
    await expect(readDownloadQueue({}, { signal: AbortSignal.abort() }, deps)).rejects.toMatchObject({ code: "ERR_QUERY_TIMEOUT" });
    for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
  });
});
