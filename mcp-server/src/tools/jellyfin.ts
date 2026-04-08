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
    description: "Search or list content in the Jellyfin library. Omit query to list all items of a type.",
    inputSchema: {
      query: z.string().optional().describe("Search term. Omit to list all."),
      type: z.enum(["Movie", "Series", "Episode", "Audio"]).optional().describe("Filter by type"),
      limit: z.number().default(50),
    },
  }, async ({ query, type, limit }) => {
    let ep = `/Items?Recursive=true&Limit=${limit}`;
    if (query) ep += `&searchTerm=${encodeURIComponent(query)}`;
    if (type) ep += `&IncludeItemTypes=${type}`;
    if (!query && !type) ep += `&IncludeItemTypes=Series,Movie`;
    const data = await jfApi(ep);
    return textResult({ total: data.TotalRecordCount, results: data.Items.map((i: any) => ({
      id: i.Id, name: i.Name, type: i.Type, year: i.ProductionYear, series: i.SeriesName || null, path: i.Path,
      episode: i.Type === "Episode" ? `S${String(i.ParentIndexNumber).padStart(2, "0")}E${String(i.IndexNumber).padStart(2, "0")}` : null,
    }))});
  });

  // 4. SHOW DETAILS
  server.registerTool("show_details", {
    description: "Get detailed info about a TV show including seasons and episodes",
    inputSchema: {
      showId: z.string().describe("Jellyfin item ID"),
    },
  }, async ({ showId }) => {
    const lookup = await jfApi(`/Items?ids=${showId}`);
    const show = lookup.Items?.[0];
    if (!show) throw new Error("Item not found");
    if (show.Type === "Series") {
      const seasons = await jfApi(`/Shows/${showId}/Seasons`);
      const details = await Promise.all(seasons.Items.map(async (s: any) => {
        const eps = await jfApi(`/Shows/${showId}/Episodes?SeasonId=${s.Id}`);
        return { name: s.Name, number: s.IndexNumber, episodes: eps.Items.map((e: any) => ({ id: e.Id, number: e.IndexNumber, name: e.Name, hasSubtitles: e.HasSubtitles, path: e.Path })) };
      }));
      return textResult({ name: show.Name, year: show.ProductionYear, overview: show.Overview, genres: show.Genres, rating: show.CommunityRating, status: show.Status, seasons: details });
    }
    return textResult({ name: show.Name, year: show.ProductionYear, overview: show.Overview, genres: show.Genres, rating: show.CommunityRating, path: show.Path });
  });
}
