import { z } from "zod";
import type { DataSourceStatus, ToolEnvelope } from "@mediabox/contracts";
import { sonarrApi, radarrApi } from "../helpers/api.js";
import { qbitApi } from "../helpers/qbittorrent.js";
import { QueryBudgetTracker } from "./budgets.js";
import { createToolEnvelope } from "./envelope.js";

export const downloadQueueInput = {
  source: z.enum(["all", "sonarr", "radarr", "qbittorrent"]).default("all"),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(5).default(5).describe("Rows per source; at most 15 rows across all clients"),
};
const inputSchema = z.object(downloadQueueInput).strict();
type Source = "sonarr" | "radarr" | "qbittorrent";
type Input = z.input<typeof inputSchema>;
const SOURCES: Source[] = ["sonarr", "radarr", "qbittorrent"];
const TIMEOUT_MS = 5_000;

export interface QueueReadDeps {
  sonarr: (endpoint: string, signal: AbortSignal) => Promise<unknown>;
  radarr: (endpoint: string, signal: AbortSignal) => Promise<unknown>;
  qbittorrent: (endpoint: string, signal: AbortSignal) => Promise<unknown>;
}
const defaults: QueueReadDeps = {
  sonarr: (ep) => sonarrApi(ep, "GET", undefined, TIMEOUT_MS),
  radarr: (ep) => radarrApi(ep, "GET", undefined, TIMEOUT_MS),
  qbittorrent: (ep, signal) => qbitApi(ep, "GET", undefined, signal),
};

interface QueueRow {
  id: string | number | null;
  title: string | null;
  status: string | null;
  progressPercent: number | null;
}
interface QueuePage {
  source: Source;
  records: QueueRow[] | null;
  total: number | null;
  pagination: { page: number; pageSize: number; hasMore: boolean | null; nextPage: number | null };
}

// Bound the JSON encoding, including control characters and multibyte titles.
// Five small rows per source keep the full page below the envelope's 8 KiB cap.
function boundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes) return value;
  let result = "";
  for (const char of value) {
    if (Buffer.byteLength(JSON.stringify(result + char + "..."), "utf8") > maxBytes) break;
    result += char;
  }
  return result + "...";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function project(raw: unknown, source: Source): QueueRow {
  const row = record(raw);
  if (!row) throw new Error("Invalid queue record");
  const size = nonnegative(row.size);
  const remaining = nonnegative(row.sizeleft);
  const progress = source === "qbittorrent" ? nonnegative(row.progress)
    : size && remaining !== null ? 1 - remaining / size : null;
  return {
    id: source === "qbittorrent" ? boundedText(row.hash, 80)
      : nonnegative(row.id),
    title: boundedText(source === "qbittorrent" ? row.name : row.title, 180),
    status: boundedText(source === "qbittorrent" ? row.state : row.status, 64),
    progressPercent: progress !== null && progress >= 0 && progress <= 1
      ? Math.round(progress * 10_000) / 100 : null,
  };
}

/** One bounded GET per selected source. Pages and totals remain source-specific:
 * an Arr item and its torrent can describe the same download, so summing them
 * would invent a global download count. qBittorrent does not report a total.
 */
export async function readDownloadQueue(
  input: Input = {},
  options: { signal?: AbortSignal; budget?: QueryBudgetTracker } = {},
  deps: QueueReadDeps = defaults,
): Promise<ToolEnvelope<{ queues: QueuePage[]; note: string }>> {
  const { source, page, pageSize } = inputSchema.parse(input);
  const selected = source === "all" ? SOURCES : [source];
  const budget = options.budget ?? new QueryBudgetTracker({ signal: options.signal });
  // Reserve every read before any dispatch; a rejected budget performs no I/O.
  for (const _ of selected) budget.recordPageFetch();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  const offset = (page - 1) * pageSize;
  const replies = await Promise.all(selected.map(async (client) => {
    const sourceStatus: DataSourceStatus = { source: client, observedAt: new Date().toISOString(), completeness: "complete" };
    const pagination: QueuePage["pagination"] = { page, pageSize, hasMore: null, nextPage: null };
    try {
      // qBit's extra row provides hasMore without fetching an unbounded list.
      const endpoint = client === "qbittorrent"
        ? `torrents/info?filter=all&sort=added_on&reverse=false&offset=${offset}&limit=${pageSize + 1}`
        : `queue?page=${page}&pageSize=${pageSize}&sortKey=timeleft&sortDirection=ascending&${client === "sonarr" ? "includeUnknownSeriesItems" : "includeUnknownMovieItems"}=true`;
      const raw = await deps[client](endpoint, signal);
      const payload = record(raw);
      const rows = client === "qbittorrent" ? raw : payload?.records;
      if (!Array.isArray(rows)) throw new Error("Invalid queue response");
      const count = client === "qbittorrent" ? null : nonnegative(payload?.totalRecords);
      const total = count !== null && Number.isInteger(count) ? count : null;
      if (client !== "qbittorrent" && total === null) sourceStatus.completeness = "partial";
      pagination.hasMore = total !== null ? offset + rows.length < total
        : client === "qbittorrent" ? rows.length > pageSize : rows.length >= pageSize;
      pagination.nextPage = pagination.hasMore ? page + 1 : null;
      const data: QueuePage = { source: client, records: rows.slice(0, pageSize).map((row) => project(row, client)), total, pagination };
      return { data, sourceStatus };
    } catch {
      // Raw upstream bodies/URLs can carry credentials. Do not expose them.
      sourceStatus.completeness = "unavailable";
      sourceStatus.error = { code: "ERR_UPSTREAM_UNAVAILABLE", message: `${client} queue could not be read; its count and state are unknown.` };
      return { data: { source: client, records: null, total: null, pagination } satisfies QueuePage, sourceStatus };
    }
  }));
  budget.checkSignal();
  return createToolEnvelope({
    data: { queues: replies.map((reply) => reply.data), note: "Separate client queues may overlap. Null means unknown, not zero. qBittorrent does not supply a total." },
    sources: replies.map((reply) => reply.sourceStatus),
    page: { pageIndex: page, pageSize, totalItems: null, hasMore: replies.some(({ data }) => data.pagination.hasMore === true) },
    budget: { itemsReturned: replies.reduce((count, { data }) => count + (data.records?.length ?? 0), 0) },
  });
}
