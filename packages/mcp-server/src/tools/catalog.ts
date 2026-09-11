import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { statfs } from "node:fs/promises";
import type { DataSourceStatus } from "@mediabox/contracts";
import { searchCatalog } from "../queries/catalog.js";
import { verifyMediaRef, verifyReleaseRef } from "../queries/references.js";
import { findAndRankReleases, type RawReleaseItem } from "../queries/releases.js";
import { createToolEnvelope, createErrorEnvelope } from "../queries/envelope.js";
import { runEnvelopeTool } from "../queries/tool-result.js";
import { QueryBudgetTracker } from "../queries/budgets.js";
import { querySonarrSafe, queryRadarrSafe, queryJellyfinSafe } from "../queries/clients.js";
import { createDownloadPlan, type ActiveDownload, type DownloadService } from "../operations/planners/download.js";
import { defaultOperationStore } from "../operations/default-store.js";
import { getLibrary } from "../fetchers/library.js";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";
import { formatBytes } from "../fetchers/utils.js";
import { defaultToolContext, resolvePlanScope, type McpToolContext } from "../security/context.js";

type ToolExtra = { signal?: AbortSignal } | undefined;

const UPSTREAM_TIMEOUT_MS = 20_000;

function budgetFor(extra: ToolExtra): QueryBudgetTracker {
  const signals: AbortSignal[] = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)];
  if (extra?.signal) signals.push(extra.signal);
  return new QueryBudgetTracker({ signal: AbortSignal.any(signals) });
}

function serviceFromPayload(payload: { id: string; serviceEntityIds?: Record<string, unknown>; mediaId?: string }): DownloadService | undefined {
  const declared = payload.serviceEntityIds?.service;
  if (declared === "sonarr" || declared === "radarr") return declared;
  const id = payload.mediaId ?? payload.id;
  if (id.startsWith("series:")) return "sonarr";
  if (id.startsWith("movie:")) return "radarr";
  return undefined;
}

async function loadActiveQueue(service: DownloadService): Promise<{ queue: ActiveDownload[]; source: DataSourceStatus }> {
  const query = service === "sonarr" ? querySonarrSafe : queryRadarrSafe;
  const res = await query<any>("queue?page=1&pageSize=200&includeUnknownSeriesItems=true&includeUnknownMovieItems=true");
  const records: any[] = Array.isArray(res.data?.records) ? res.data.records : [];
  const entityKey = service === "sonarr" ? "seriesId" : "movieId";
  return {
    queue: records.map((r) => ({
      service,
      queueId: Number(r.id),
      downloadId: r.downloadId ? String(r.downloadId) : undefined,
      title: r.title ? String(r.title) : undefined,
      entityId: typeof r[entityKey] === "number" ? r[entityKey] : undefined,
    })),
    source: res.sourceStatus,
  };
}

export function registerCatalogTools(server: McpServer, context: McpToolContext = defaultToolContext()): void {
  const scope = resolvePlanScope(context);
  const refContext = { installationId: scope.installationId, ownerId: scope.ownerId };
  const principalId = context.principal.id;

  // -------------------------------------------------------------------------
  // 1. SEARCH MEDIA
  // -------------------------------------------------------------------------
  server.registerTool(
    "search_media",
    {
      description:
        "Search movies and series across Sonarr/Radarr lookups with structured disambiguation. Returns a ToolEnvelope with non-colliding mediaRef tokens; page with the opaque cursor.",
      inputSchema: {
        query: z.string().min(1).describe("Title or search term to search for"),
        type: z.enum(["movie", "series", "all"]).default("all").describe("Filter by media type"),
        year: z.number().int().optional().describe("Release year to disambiguate homonyms or remakes"),
        cursor: z.string().optional().describe("Opaque pagination cursor from a previous response"),
        pageSize: z.number().int().min(1).max(50).optional().default(10).describe("Items per page (max 50)"),
      },
    },
    async ({ query, type, year, cursor, pageSize }, extra: ToolExtra) =>
      runEnvelopeTool(() =>
        searchCatalog(
          { query, type, year, cursor, pageSize },
          { ...scope, principalId, budget: budgetFor(extra) }
        )
      )
  );

  // -------------------------------------------------------------------------
  // 2. MEDIA DETAILS
  // -------------------------------------------------------------------------
  server.registerTool(
    "media_details",
    {
      description: "Fetch detailed information and library status for a specific media item using its opaque mediaRef.",
      inputSchema: {
        mediaRef: z.string().describe("Opaque media reference token obtained from search_media"),
      },
    },
    async ({ mediaRef }) =>
      runEnvelopeTool(async () => {
        const payload = verifyMediaRef(mediaRef, refContext);
        const sources: DataSourceStatus[] = [];
        let details: Record<string, unknown> = {
          id: payload.id,
          title: payload.title,
          providerIds: payload.serviceEntityIds,
        };

        const sonarrId = payload.serviceEntityIds?.sonarrId;
        const radarrId = payload.serviceEntityIds?.radarrId;
        if (payload.id.startsWith("series:") && typeof sonarrId === "number") {
          const res = await querySonarrSafe(`series/${sonarrId}`);
          sources.push(res.sourceStatus);
          if (res.data) details = { ...details, library: res.data };
        } else if (payload.id.startsWith("movie:") && typeof radarrId === "number") {
          const res = await queryRadarrSafe(`movie/${radarrId}`);
          sources.push(res.sourceStatus);
          if (res.data) details = { ...details, library: res.data };
        }

        return createToolEnvelope({ data: details, sources });
      })
  );

  // -------------------------------------------------------------------------
  // 3. FIND RELEASES
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_releases",
    {
      description:
        "Search and deterministically rank torrent/usenet releases for a media item that is already in Sonarr/Radarr. Generates opaque releaseRef tokens for propose_download. Ranking is server-side (policy v1); do not re-rank.",
      inputSchema: {
        mediaRef: z.string().describe("Opaque media reference token"),
        resolution: z.enum(["1080p", "720p", "2160p"]).optional().describe("Preferred resolution"),
        audioLanguage: z.string().optional().describe("Preferred audio language (e.g. 'latino', 'es', 'en')"),
        strictLanguage: z.boolean().default(false).describe("If true, rejects unknown/mismatched audio languages"),
        minSeeders: z.number().int().min(0).default(1).describe("Minimum required seeders (defaults to 1)"),
      },
    },
    async ({ mediaRef, resolution, audioLanguage, strictLanguage, minSeeders }, extra: ToolExtra) =>
      runEnvelopeTool(async () => {
        const budget = budgetFor(extra);
        const payload = verifyMediaRef(mediaRef, refContext);
        const service = serviceFromPayload(payload);
        const entityIdRaw = payload.serviceEntityIds?.[service === "sonarr" ? "sonarrId" : "radarrId"];
        const entityId = typeof entityIdRaw === "number" ? entityIdRaw : undefined;

        if (!service || entityId === undefined) {
          return createErrorEnvelope({
            code: "ERR_NOT_IN_LIBRARY",
            message: "This media is not registered in Sonarr/Radarr yet; releases can only be searched for registered items",
          });
        }

        budget.recordReleaseSearch();
        const query = service === "sonarr" ? querySonarrSafe : queryRadarrSafe;
        const endpoint = service === "sonarr" ? `release?seriesId=${entityId}` : `release?movieId=${entityId}`;
        const res = await query<RawReleaseItem[]>(endpoint);
        const rawReleases = Array.isArray(res.data) ? res.data : [];

        return findAndRankReleases(
          payload.id,
          service === "sonarr" ? "series" : "movie",
          rawReleases,
          { minSeeders, preferredResolution: resolution, requiredAudioLanguage: audioLanguage, strictAudioLanguage: strictLanguage },
          { ...scope, entityId },
          [res.sourceStatus]
        );
      })
  );

  // -------------------------------------------------------------------------
  // 4. PROPOSE DOWNLOAD
  // -------------------------------------------------------------------------
  server.registerTool(
    "propose_download",
    {
      description:
        "Propose an operation plan to grab a specific releaseRef. Nothing is downloaded until the owner approves the plan in the Mediabox app. Duplicates are refused against the live queue; replacement:true is the only way an existing download gets cancelled.",
      inputSchema: {
        releaseRef: z.string().describe("Opaque release reference token from find_releases"),
        mediaRef: z.string().optional().describe("Associated media reference token"),
        replacement: z.boolean().default(false).describe("If true, plans explicit replacement of the active download for the same media"),
      },
    },
    async ({ releaseRef, mediaRef, replacement }) =>
      runEnvelopeTool(async () => {
        const payload = verifyReleaseRef(releaseRef, refContext);
        const service = serviceFromPayload(payload);
        if (!service) {
          return createErrorEnvelope({ code: "ERR_UNKNOWN_SERVICE", message: "Cannot determine which service manages this release" });
        }

        // Mutations revalidate fresh state: a duplicate check needs the live queue.
        const { queue, source } = await loadActiveQueue(service);
        if (source.completeness !== "complete") {
          return createErrorEnvelope({
            code: "ERR_UPSTREAM_UNAVAILABLE",
            message: `${service} queue is unavailable; cannot verify duplicates before proposing a download`,
            sources: [source],
            retryable: true,
          });
        }

        const { plan, summary } = createDownloadPlan({ releaseRef, mediaRef, replacement, scope, activeQueue: queue });
        // Idempotent: the store returns the plan already awaiting approval for the
        // same proposal key instead of creating a second one (§2.8 / AGT-08).
        const record = defaultOperationStore.createPlan(plan, "awaiting_approval");
        const effective = record.plan;
        const duplicate = effective.id !== plan.id;

        return createToolEnvelope({
          data: {
            planId: effective.id,
            operation: effective.operation,
            status: record.status,
            manifestHash: effective.manifestHash,
            expiresAt: effective.expiresAt,
            proposalKey: effective.proposalKey,
            duplicate,
            summary,
            effects: effective.effects.map((e) => ({ action: e.serviceAction, irreversibleLoss: e.irreversibleLoss })),
            message: duplicate
              ? `Plan ${effective.id} for this release is already awaiting your approval in the Mediabox app; no second plan was created.`
              : "Plan awaiting owner approval in the Mediabox app. Do not claim the download started; check operation_status for progress.",
          },
          sources: [source],
        });
      })
  );

  // -------------------------------------------------------------------------
  // 5. LIBRARY SUMMARY
  // -------------------------------------------------------------------------
  server.registerTool(
    "library_summary",
    {
      description: "Structured aggregated summary of the Jellyfin media library. Distinguishes upstream unavailability from empty counts.",
      inputSchema: {},
    },
    async () =>
      runEnvelopeTool(async () => {
        const jfFolders = await queryJellyfinSafe<any[]>("/Library/VirtualFolders");
        if (jfFolders.sourceStatus.completeness !== "complete") {
          return createToolEnvelope({
            data: null,
            sources: [jfFolders.sourceStatus],
            warnings: ["Jellyfin service is currently offline or unreachable"],
          });
        }
        const stats = await getLibrary();
        return createToolEnvelope({ data: stats, sources: [jfFolders.sourceStatus] });
      })
  );

  // -------------------------------------------------------------------------
  // 6. STORAGE SUMMARY
  // -------------------------------------------------------------------------
  server.registerTool(
    "storage_summary",
    {
      description: "Structured storage usage and capacity metrics across media and downloads volumes.",
      inputSchema: {},
    },
    async () =>
      runEnvelopeTool(async () => {
        const sources: DataSourceStatus[] = [];
        const volumes: Record<string, unknown> = {};

        for (const [name, dir] of [["media", MEDIA_PATH], ["downloads", DOWNLOADS_PATH]] as const) {
          const observedAt = new Date().toISOString();
          try {
            const s = await statfs(dir);
            const total = Number(s.blocks) * Number(s.bsize);
            const free = Number(s.bavail) * Number(s.bsize);
            volumes[name] = {
              path: dir,
              totalBytes: total,
              freeBytes: free,
              usedBytes: total - free,
              formattedTotal: formatBytes(total),
              formattedFree: formatBytes(free),
            };
            sources.push({ source: `filesystem:${name}`, observedAt, completeness: "complete" });
          } catch (err: any) {
            volumes[name] = null;
            sources.push({
              source: `filesystem:${name}`,
              observedAt,
              completeness: "unavailable",
              error: { code: "ERR_FS_UNAVAILABLE", message: String(err?.message ?? err) },
            });
          }
        }

        return createToolEnvelope({ data: volumes, sources });
      })
  );
}
