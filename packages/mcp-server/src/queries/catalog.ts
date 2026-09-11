import { createHash, randomUUID } from "node:crypto";
import type { MediaItem, ToolEnvelope, DataSourceStatus } from "@mediabox/contracts";
import { createToolEnvelope } from "./envelope.js";
import { paginateSlice, verifyOpaqueCursor, CursorValidationError } from "./pagination.js";
import { createMediaRef } from "./references.js";
import { querySonarrSafe, queryRadarrSafe, type ServiceQueryResult } from "./clients.js";
import { QueryCache, defaultQueryCache } from "./cache.js";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, type QueryBudgetTracker } from "./budgets.js";

export interface SearchCatalogOptions {
  query: string;
  year?: number;
  type?: "movie" | "series" | "all";
  cursor?: string;
  pageSize?: number;
}

export interface CatalogContext {
  installationId: string;
  ownerId: string;
  conversationId: string;
  /** Principal the cursor/cache entries are bound to; defaults to ownerId. */
  principalId?: string;
  budget?: QueryBudgetTracker;
}

export interface CatalogDeps {
  sonarrLookup: (term: string) => Promise<ServiceQueryResult<any[]>>;
  radarrLookup: (term: string) => Promise<ServiceQueryResult<any[]>>;
  cache?: QueryCache;
}

export const CATALOG_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
export const CATALOG_CACHE_TAG = "catalog";

const defaultDeps: CatalogDeps = {
  sonarrLookup: (term) => querySonarrSafe<any[]>(`series/lookup?term=${encodeURIComponent(term)}`),
  radarrLookup: (term) => queryRadarrSafe<any[]>(`movie/lookup?term=${encodeURIComponent(term)}`),
};

interface CatalogSnapshot {
  items: MediaItem[];
  sources: DataSourceStatus[];
  snapshotId: string;
}

/**
 * Builds a canonical, non-colliding ID for media items (CAT-01).
 * Homonyms with different years or different provider IDs will never collide.
 */
export function buildCanonicalMediaId(item: {
  type: "movie" | "series" | "episode" | "music";
  title: string;
  year?: number;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
}): string {
  if (item.type === "movie" && item.tmdbId) {
    return `movie:tmdb:${item.tmdbId}`;
  }
  if (item.type === "series" && item.tvdbId) {
    return `series:tvdb:${item.tvdbId}`;
  }
  if (item.imdbId) {
    return `${item.type}:imdb:${item.imdbId}`;
  }
  const cleanTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const yearSuffix = item.year ? `:${item.year}` : "";
  return `${item.type}:${cleanTitle}${yearSuffix}`;
}

export function catalogFilterHash(options: SearchCatalogOptions): string {
  const canonical = JSON.stringify({ q: options.query.trim().toLowerCase(), t: options.type ?? "all", y: options.year ?? null });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function snapshotKey(installationId: string, principalId: string, snapshotId: string): string {
  return `inst:${installationId}:principal:${principalId}:catalog-snapshot:${snapshotId}`;
}

async function fetchSnapshot(options: SearchCatalogOptions, context: CatalogContext, deps: CatalogDeps): Promise<CatalogSnapshot> {
  const snapshotId = `snap_${randomUUID()}`;
  const sources: DataSourceStatus[] = [];
  const items: MediaItem[] = [];
  const typeFilter = options.type || "all";
  const refContext = {
    installationId: context.installationId,
    ownerId: context.ownerId,
    conversationId: context.conversationId,
  };

  if (typeFilter === "series" || typeFilter === "all") {
    const sonarrLookup = await deps.sonarrLookup(options.query);
    sources.push({ ...sonarrLookup.sourceStatus, snapshotId });
    if (Array.isArray(sonarrLookup.data)) {
      for (const s of sonarrLookup.data) {
        if (options.year && s.year && s.year !== options.year) continue;
        const canonicalId = buildCanonicalMediaId({ type: "series", title: s.title, year: s.year, tvdbId: s.tvdbId, imdbId: s.imdbId });
        const providerIds = { tvdbId: s.tvdbId, sonarrId: s.id, imdbId: s.imdbId };
        const inLibrary = Boolean(s.id);
        items.push({
          id: canonicalId,
          mediaRef: createMediaRef({ id: canonicalId, title: s.title, providerIds: { ...providerIds, service: "sonarr" }, snapshotId }, refContext),
          title: s.title,
          year: s.year,
          type: "series",
          overview: s.overview,
          providerIds,
          inLibrary,
          libraryStatus: inLibrary
            ? {
                monitored: s.monitored,
                status: s.status,
                downloadedEpisodes: s.statistics?.episodeFileCount,
                totalEpisodes: s.statistics?.totalEpisodeCount,
              }
            : undefined,
        });
      }
    }
  }

  if (typeFilter === "movie" || typeFilter === "all") {
    const radarrLookup = await deps.radarrLookup(options.query);
    sources.push({ ...radarrLookup.sourceStatus, snapshotId });
    if (Array.isArray(radarrLookup.data)) {
      for (const m of radarrLookup.data) {
        if (options.year && m.year && m.year !== options.year) continue;
        const canonicalId = buildCanonicalMediaId({ type: "movie", title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId });
        const providerIds = { tmdbId: m.tmdbId, radarrId: m.id, imdbId: m.imdbId };
        const inLibrary = Boolean(m.id && m.hasFile);
        items.push({
          id: canonicalId,
          mediaRef: createMediaRef({ id: canonicalId, title: m.title, providerIds: { ...providerIds, service: "radarr" }, snapshotId }, refContext),
          title: m.title,
          year: m.year,
          type: "movie",
          overview: m.overview,
          providerIds,
          inLibrary,
          libraryStatus: inLibrary ? { monitored: m.monitored, status: m.status } : undefined,
        });
      }
    }
  }

  return { items, sources, snapshotId };
}

/**
 * Searches Sonarr/Radarr lookups and returns a paginated envelope. A fresh
 * search stores its result set as a snapshot bound to installation and
 * principal; cursors page over that stable snapshot until it expires
 * (Blueprint 4.4, QRY-04/QRY-05).
 */
export async function searchCatalog(
  options: SearchCatalogOptions,
  context: CatalogContext,
  deps: CatalogDeps = defaultDeps
): Promise<ToolEnvelope<MediaItem[]>> {
  const cache = deps.cache ?? defaultQueryCache;
  const principalId = context.principalId ?? context.ownerId;
  const filterHash = catalogFilterHash(options);
  const cacheContext = { installationId: context.installationId, principalId };
  const pageSize = Math.min(Math.max(1, options.pageSize || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

  let snapshot: CatalogSnapshot;
  if (options.cursor) {
    context.budget?.recordPageFetch();
    const payload = verifyOpaqueCursor(options.cursor, { principalId, installationId: context.installationId, filterHash });
    const cached = cache.get<CatalogSnapshot>(snapshotKey(context.installationId, principalId, payload.snapshotId), cacheContext);
    if (!cached) {
      throw new CursorValidationError("Search snapshot expired; run the search again", "ERR_EXPIRED_CURSOR");
    }
    snapshot = cached;
  } else {
    context.budget?.recordPageFetch();
    snapshot = await fetchSnapshot(options, context, deps);
    cache.set(snapshotKey(context.installationId, principalId, snapshot.snapshotId), snapshot, cacheContext, CATALOG_SNAPSHOT_TTL_MS, [CATALOG_CACHE_TAG]);
  }

  const { data: pageData, page } = paginateSlice(
    snapshot.items,
    options.cursor,
    pageSize,
    { principalId, installationId: context.installationId, snapshotId: snapshot.snapshotId, filterHash },
    snapshot.items.length
  );

  return createToolEnvelope<MediaItem[]>({
    data: pageData,
    sources: snapshot.sources,
    page,
    budget: {
      itemsReturned: pageData.length,
      itemsAvailable: snapshot.items.length,
    },
  });
}
