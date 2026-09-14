import { statfs } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jfApi, jfCountByParent, textResult } from "../helpers/api.js";
import { MEDIA_PATH } from "../config.js";
import { formatBytes } from "../fetchers/utils.js";

/** Block counts of the media disk, as statfs reports them. */
export interface MediaDiskStats {
  blocks: number | bigint;
  bsize:  number | bigint;
  bfree:  number | bigint;
}

export interface MediaDisk {
  name:        "media library";
  path:        string;
  total:       string;
  used:        string;
  free:        string;
  usedPercent: number;
}

// READ-07, experiments 5 and 6: asked about the external backup disk, both models
// reported the free space of the one unnamed disk as the backup's. The disk is named
// and the note says what its figures do not cover. Review finding D3: server_status
// only knows MEDIA_PATH, so the notes must not claim that no other disk is configured,
// and "no disk space is available" read as a full disk. Both notes stay within the 120
// characters compaction keeps of a string (chat-core agent/budget.ts).
export const MEDIA_DISK_NOTE = "These figures are for the media library disk only; any other disk (backup, external) is unknown here.";
export const NO_DISK_NOTE    = "Disk space is unknown: the media library disk could not be read; any other disk (backup, external) is unknown too.";

/**
 * The disk part of server_status. `disk` keeps the shape its readers know (the
 * object, or "N/A" when statfs failed) and only gains `name`; `diskNote` is new.
 */
export function describeMediaDisk(mediaPath: string, stats: MediaDiskStats | null): { disk: MediaDisk | "N/A"; diskNote: string } {
  if (!stats) return { disk: "N/A", diskNote: NO_DISK_NOTE };
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free  = Number(stats.bfree)  * Number(stats.bsize);
  const used  = total - free;
  return {
    disk: {
      name:        "media library",
      path:        mediaPath,
      total:       formatBytes(total),
      used:        formatBytes(used),
      free:        formatBytes(free),
      usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
    },
    diskNote: MEDIA_DISK_NOTE,
  };
}

/**
 * One season of show_details, counted over every episode of the season, never only
 * the page of episodes the result lists (READ-11 pages an 80-episode season).
 */
export interface SeasonSummary {
  season?:          number;
  name?:            string;
  episodesWithFile: number;
  /** Present only when Jellyfin itself lists episodes of the season without a file. */
  missingEpisodes?: number;
  /** Present, and false, only in that same case. */
  complete?:        boolean;
}

/**
 * Jellyfin lists an episode it knows of but has no file for as a virtual item
 * (LocationType "Virtual"; `IsMissing` where a server reports it).
 */
export function isMissingEpisode(episode: any): boolean {
  return episode?.LocationType === "Virtual" || episode?.IsMissing === true;
}

// READ-04, G10 experiment 7 (pr05-g10-20260914T154155-5e160936): asked which seasons
// were complete, the model listed the episodes of each season but wrote that season 2
// "tiene solo el primer episodio visto" and never called it incomplete. The summary
// says, per season, how many episodes have a file. It never assumes how many episodes
// a season should have: `missingEpisodes` and `complete: false` appear only when
// Jellyfin lists episodes of that season without a file, and a season with none gets
// no completeness claim, because Jellyfin may simply not report missing episodes.
// The synthetic Jellyfin of the G10 corpus lists no such episode, so for READ-04 the
// summary gives 3 and 1 episodes with a file and says nothing about completeness.
export function summarizeSeason(season: { IndexNumber?: number; Name?: string }, episodes: any[]): SeasonSummary {
  const missing = episodes.filter(isMissingEpisode).length;
  const summary: SeasonSummary = { season: season.IndexNumber, name: season.Name, episodesWithFile: episodes.length - missing };
  if (missing > 0) {
    summary.missingEpisodes = missing;
    summary.complete = false;
  }
  return summary;
}

export function registerJellyfinTools(server: McpServer): void {
  // 1. SERVER STATUS
  server.registerTool("server_status", {
    description: "Complete server overview: Jellyfin info, disk usage, per-library stats, active sessions, and users",
  }, async () => {
    const [sysInfo, sessions, folders, users] = await Promise.all([
      jfApi("/System/Info"), jfApi("/Sessions"), jfApi("/Library/VirtualFolders"), jfApi("/Users"),
    ]);

    // Per-library counts: only query item types relevant to each library's
    // CollectionType so the LLM sees songs in Music, movies in Movies, etc.
    const libraryStats = await Promise.all(folders.map(async (f: any) => {
      const t   = String(f.CollectionType || "").toLowerCase();
      const out: Record<string, unknown> = { name: f.Name, type: f.CollectionType, paths: f.Locations };
      const tasks: Promise<void>[] = [];
      const wantMovies = t === "movies"  || t === "homevideos" || t === "mixed" || t === "";
      const wantShows  = t === "tvshows" || t === "mixed"      || t === "";
      const wantMusic  = t === "music"   || t === "mixed"      || t === "";
      if (wantMovies) tasks.push(jfCountByParent(f.ItemId, "Movie") .then(n => { out.movies   = n; }));
      if (wantShows)  tasks.push(jfCountByParent(f.ItemId, "Series").then(n => { out.series   = n; }));
      if (wantShows)  tasks.push(jfCountByParent(f.ItemId, "Episode").then(n => { out.episodes = n; }));
      if (wantMusic)  tasks.push(jfCountByParent(f.ItemId, "Audio") .then(n => { out.songs    = n; }));
      await Promise.all(tasks);
      return out;
    }));

    const stats = await statfs(MEDIA_PATH).catch(() => null); // MEDIA_PATH unavailable
    const { disk, diskNote } = describeMediaDisk(MEDIA_PATH, stats);
    return textResult({
      server: { name: sysInfo.ServerName, version: sysInfo.Version, os: sysInfo.OperatingSystem },
      disk,
      diskNote,
      libraries: libraryStats,
      activeSessions: sessions.filter((s: any) => s.NowPlayingItem).map((s: any) => ({
        user: s.UserName, device: s.DeviceName, playing: s.NowPlayingItem?.Name,
        playMethod: s.PlayState?.PlayMethod, isPaused: s.PlayState?.IsPaused,
      })),
      users: users.map((u: any) => ({ name: u.Name, isAdmin: u.Policy?.IsAdministrator, lastActive: u.LastActivityDate })),
    });
  });

  // 2. ACTIVITY LOG
  server.registerTool("activity_log", {
    description: "Recent server activity: who watched what, logins, library changes",
    inputSchema: {
      limit: z.number().default(15).describe("Number of entries to return"),
    },
  }, async ({ limit }) => {
    const [log, users] = await Promise.all([
      jfApi(`/System/ActivityLog/Entries?limit=${limit}`),
      // Activity entries only carry UserId; names come from /Users.
      jfApi(`/Users`).catch(() => []),
    ]);
    const userNames = new Map<string, string>((Array.isArray(users) ? users : []).map((u: any) => [u.Id, u.Name]));
    return textResult(log.Items.map((e: any) => ({
      type: e.Type,
      name: e.Name,
      date: e.Date?.slice(0, 16),
      user: e.UserName ?? (e.UserId ? userNames.get(e.UserId) : undefined),
    })));
  });

  // 3. JELLYFIN SEARCH
  server.registerTool("jellyfin_search", {
    description: "Search Jellyfin by title, or omit query to list library items by type and production year. Filters apply upstream before pagination.",
    inputSchema: {
      query: z.string().optional().describe("Search term. Omit to list all."),
      type: z.enum(["Movie", "Series", "Episode", "Audio"]).optional().describe("Filter by type"),
      year: z.number().int().min(1).max(9999).optional().describe("Production year filter (Jellyfin Years)"),
      page: z.number().int().min(1).max(1_000_000).default(1).describe("Page number (1-based)"),
      pageSize: z.number().int().min(1).max(50).default(50).describe("Items per page (max 50)"),
    },
  }, async ({ query, type, year, page, pageSize }) => {
    const offset = (page - 1) * pageSize;
    let ep = `/Items?Recursive=true&Limit=${pageSize}&StartIndex=${offset}&Fields=Path&EnableTotalRecordCount=true&SortBy=SortName&SortOrder=Ascending`;
    if (query) ep += `&searchTerm=${encodeURIComponent(query)}`;
    if (type) ep += `&IncludeItemTypes=${type}`;
    // Jellyfin's ItemsController applies Years before Limit/StartIndex.
    if (year !== undefined) ep += `&Years=${year}`;
    if (!query && !type) ep += `&IncludeItemTypes=Series,Movie`;
    const data = await jfApi(ep);
    const totalItems = data.TotalRecordCount;
    const totalPages = Math.ceil(totalItems / pageSize);
    return textResult({ total: totalItems, results: data.Items.map((i: any) => ({
      id: i.Id, name: i.Name, type: i.Type, year: i.ProductionYear, series: i.SeriesName || null, path: i.Path,
      episode: i.Type === "Episode" ? `S${String(i.ParentIndexNumber).padStart(2, "0")}E${String(i.IndexNumber).padStart(2, "0")}` : null,
    })), pagination: { page, pageSize, totalPages, totalItems, hasMore: page < totalPages }});
  });

  // 4. SHOW DETAILS
  server.registerTool("show_details", {
    description: "Get detailed info about a TV show including seasons and episodes. For large series, use seasonNumber to get one season at a time, or page/pageSize to paginate episodes.",
    inputSchema: {
      showId: z.string().describe("Jellyfin item ID"),
      seasonNumber: z.number().optional().describe("Return only this season number (recommended for large series)"),
      page: z.number().default(1).describe("Page number (1-based)"),
      pageSize: z.number().default(50).describe("Episodes per page"),
    },
  }, async ({ showId, seasonNumber, page, pageSize }) => {
    const lookup = await jfApi(`/Items?ids=${showId}`);
    const show = lookup.Items?.[0];
    if (!show) throw new Error("Item not found");
    if (show.Type === "Series") {
      const seasons = await jfApi(`/Shows/${showId}/Seasons`);
      const filteredSeasons = seasonNumber !== undefined
        ? seasons.Items.filter((s: any) => s.IndexNumber === seasonNumber)
        : seasons.Items;
      if (seasonNumber !== undefined && !filteredSeasons.length) throw new Error(`Season ${seasonNumber} not found`);

      // Collect all episodes from requested seasons
      const allEpisodes: { season: string; seasonNumber: number; episode: any }[] = [];
      const seasonSummary: SeasonSummary[] = [];
      for (const s of filteredSeasons) {
        const eps = await jfApi(`/Shows/${showId}/Episodes?SeasonId=${s.Id}&Fields=Path,MediaSources`);
        // Counted from every episode of the season, before pagination cuts the list (READ-04).
        seasonSummary.push(summarizeSeason(s, eps.Items));
        for (const e of eps.Items) {
          allEpisodes.push({
            season: s.Name,
            seasonNumber: s.IndexNumber,
            episode: {
              id: e.Id, number: e.IndexNumber, name: e.Name, hasSubtitles: e.HasSubtitles, path: e.Path,
              // An episode Jellyfin lists without a file is not one the owner has.
              ...(isMissingEpisode(e) ? { missing: true } : {}),
            },
          });
        }
      }

      const totalItems = allEpisodes.length;
      const totalPages = Math.ceil(totalItems / pageSize);
      const start = (page - 1) * pageSize;
      const paged = allEpisodes.slice(start, start + pageSize);

      // Group paged episodes by season
      const seasonMap = new Map<number, { name: string; number: number; episodes: any[] }>();
      for (const item of paged) {
        if (!seasonMap.has(item.seasonNumber)) seasonMap.set(item.seasonNumber, { name: item.season, number: item.seasonNumber, episodes: [] });
        seasonMap.get(item.seasonNumber)!.episodes.push(item.episode);
      }

      return textResult({
        name: show.Name, year: show.ProductionYear, overview: show.Overview, genres: show.Genres,
        rating: show.CommunityRating, status: show.Status,
        totalSeasons: seasons.Items.length,
        // A top-level list, so the agent's compaction (chat-core agent/budget.ts) keeps
        // it for this non-envelope payload whatever page of episodes is listed. It keeps
        // as many seasons as any other list and then says how many more there are.
        seasonSummary,
        seasons: [...seasonMap.values()],
        pagination: { page, pageSize, totalPages, totalItems },
      });
    }
    return textResult({ name: show.Name, year: show.ProductionYear, overview: show.Overview, genres: show.Genres, rating: show.CommunityRating, path: show.Path });
  });
}
