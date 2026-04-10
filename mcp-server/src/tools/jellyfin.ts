import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jfApi, textResult } from "../helpers/api.js";
import { execFileAsync } from "../helpers/files.js";
import { MEDIA_PATH } from "../config.js";

export function registerJellyfinTools(server: McpServer): void {
  // 1. SERVER STATUS
  server.registerTool("server_status", {
    description: "Complete server overview: Jellyfin info, disk usage, per-library stats, active sessions, and users",
  }, async () => {
    const [sysInfo, sessions, folders, users] = await Promise.all([
      jfApi("/System/Info"), jfApi("/Sessions"), jfApi("/Library/VirtualFolders"), jfApi("/Users"),
    ]);

    const libraryStats = await Promise.all(folders.map(async (f: any) => {
      try {
        const items = await jfApi(`/Items?ParentId=${f.ItemId}&Recursive=true&IncludeItemTypes=Series,Movie,Episode&Fields=BasicSyncInfo`);
        const series = items.Items?.filter((i: any) => i.Type === "Series").length || 0;
        const movies = items.Items?.filter((i: any) => i.Type === "Movie").length || 0;
        const episodes = items.Items?.filter((i: any) => i.Type === "Episode").length || 0;
        return { name: f.Name, type: f.CollectionType, paths: f.Locations, series, movies, episodes };
      } catch { return { name: f.Name, type: f.CollectionType, paths: f.Locations }; }
    }));

    let disk = "";
    try { disk = (await execFileAsync("df", ["-h", MEDIA_PATH])).stdout; } catch { disk = "N/A"; }
    return textResult({
      server: { name: sysInfo.ServerName, version: sysInfo.Version, os: sysInfo.OperatingSystem },
      disk,
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
    const log = await jfApi(`/System/ActivityLog/Entries?limit=${limit}`);
    return textResult(log.Items.map((e: any) => ({ type: e.Type, name: e.Name, date: e.Date?.slice(0, 16), user: e.UserName })));
  });

  // 3. SEARCH MEDIA
  server.registerTool("search_media", {
    description: "Search or list content in the Jellyfin library. Omit query to list all items of a type. Use offset to paginate through large result sets.",
    inputSchema: {
      query: z.string().optional().describe("Search term. Omit to list all."),
      type: z.enum(["Movie", "Series", "Episode", "Audio"]).optional().describe("Filter by type"),
      limit: z.number().default(50),
      offset: z.number().default(0).describe("Skip this many results (for pagination)"),
    },
  }, async ({ query, type, limit, offset }) => {
    let ep = `/Items?Recursive=true&Limit=${limit}&StartIndex=${offset}`;
    if (query) ep += `&searchTerm=${encodeURIComponent(query)}`;
    if (type) ep += `&IncludeItemTypes=${type}`;
    if (!query && !type) ep += `&IncludeItemTypes=Series,Movie`;
    const data = await jfApi(ep);
    const totalItems = data.TotalRecordCount;
    return textResult({ total: totalItems, results: data.Items.map((i: any) => ({
      id: i.Id, name: i.Name, type: i.Type, year: i.ProductionYear, series: i.SeriesName || null, path: i.Path,
      episode: i.Type === "Episode" ? `S${String(i.ParentIndexNumber).padStart(2, "0")}E${String(i.IndexNumber).padStart(2, "0")}` : null,
    })), pagination: { offset, limit, totalItems, hasMore: offset + limit < totalItems }});
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
      for (const s of filteredSeasons) {
        const eps = await jfApi(`/Shows/${showId}/Episodes?SeasonId=${s.Id}`);
        for (const e of eps.Items) {
          allEpisodes.push({
            season: s.Name,
            seasonNumber: s.IndexNumber,
            episode: { id: e.Id, number: e.IndexNumber, name: e.Name, hasSubtitles: e.HasSubtitles, path: e.Path },
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
        seasons: [...seasonMap.values()],
        pagination: { page, pageSize, totalPages, totalItems },
      });
    }
    return textResult({ name: show.Name, year: show.ProductionYear, overview: show.Overview, genres: show.Genres, rating: show.CommunityRating, path: show.Path });
  });
}
