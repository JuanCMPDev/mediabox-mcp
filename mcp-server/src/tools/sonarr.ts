import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sonarrApi, textResult } from "../helpers/api.js";

export function registerSonarrTools(server: McpServer): void {
  server.registerTool("series_search", {
    description: "Search for a TV series and optionally add it to Sonarr for monitoring",
    inputSchema: {
      query: z.string().optional().describe("Series name to search. Required for search, optional when adding by ID."),
      addTvdbId: z.number().optional().describe("TVDB ID to add (from search results). Omit to just search."),
      rootFolder: z.enum(["/tv", "/anime"]).default("/tv"),
      monitor: z.enum(["all", "future", "missing", "none", "firstSeason", "lastSeason"]).default("all"),
      seasons: z.array(z.number()).optional().describe("Specific season numbers to monitor"),
      quality: z.enum(["Any", "SD", "HD-720p", "HD-1080p", "Ultra-HD", "HD - 720p/1080p"]).default("HD-1080p"),
    },
  }, async ({ query, addTvdbId, rootFolder, monitor, seasons, quality }) => {
    if (!addTvdbId) {
      if (!query) throw new Error("query is required when not adding by ID");
      const results = await sonarrApi(`series/lookup?term=${encodeURIComponent(query)}`);
      return textResult(results.slice(0, 10).map((s: any) => ({ title: s.title, year: s.year, tvdbId: s.tvdbId, overview: s.overview?.slice(0, 120), seasons: s.seasons?.length, status: s.status })));
    }
    const existing = (await sonarrApi("series")).find((s: any) => s.tvdbId === addTvdbId);
    const profiles = await sonarrApi("qualityprofile");
    const profile = profiles.find((p: any) => p.name === quality) || profiles[0];

    if (existing) {
      existing.monitored = true;
      if (seasons) { for (const s of existing.seasons || []) s.monitored = seasons.includes(s.seasonNumber); }
      else { for (const s of existing.seasons || []) s.monitored = true; }
      existing.qualityProfileId = profile.id;
      await sonarrApi(`series/${existing.id}`, "PUT", existing);
      if (monitor === "all" || monitor === "missing") await sonarrApi("command", "POST", { name: "SeriesSearch", seriesId: existing.id });
      const queue = await sonarrApi("queue?pageSize=100");
      const activeDownloads = (queue.records || []).filter((r: any) => r.seriesId === existing.id).length;
      return textResult({ message: `Updated "${existing.title}" monitoring`, id: existing.id, quality: profile.name, activeDownloads: activeDownloads || undefined, warning: activeDownloads ? `${activeDownloads} downloads already active for this series. Use cancel_downloads to manage.` : undefined });
    }

    const lookup = await sonarrApi(`series/lookup?term=tvdb:${addTvdbId}`);
    if (!lookup.length) throw new Error("Series not found");
    const series = lookup[0];
    if (seasons && series.seasons) { for (const s of series.seasons) s.monitored = seasons.includes(s.seasonNumber); }
    const result = await sonarrApi("series", "POST", { ...series, rootFolderPath: rootFolder, qualityProfileId: profile.id, monitored: true, addOptions: { monitor, searchForMissingEpisodes: monitor === "all" || monitor === "missing" } });
    if (seasons) {
      const added = await sonarrApi(`series/${result.id}`);
      added.monitored = true;
      for (const s of added.seasons || []) s.monitored = seasons.includes(s.seasonNumber);
      await sonarrApi(`series/${result.id}`, "PUT", added);
    }
    if (monitor === "all" || monitor === "missing") await sonarrApi("command", "POST", { name: "SeriesSearch", seriesId: result.id });
    return textResult({ message: `Added "${result.title}" (${result.year})`, id: result.id, rootFolder, quality: profile.name, monitoring: seasons ? `Seasons ${seasons.join(",")}` : monitor });
  });

  server.registerTool("series_status", {
    description: "View monitored series, calendar, missing episodes, queue, or download history",
    inputSchema: {
      view: z.enum(["series", "calendar", "missing", "queue", "history"]).default("series"),
      limit: z.number().default(20),
    },
  }, async ({ view, limit }) => {
    if (view === "series") {
      const series = await sonarrApi("series");
      return textResult(series.map((s: any) => ({ id: s.id, title: s.title, year: s.year, monitored: s.monitored, seasons: s.seasonCount, episodes: `${s.episodeFileCount}/${s.episodeCount}`, size: `${((s.statistics?.sizeOnDisk || 0) / 1073741824).toFixed(1)}GB`, root: s.rootFolderPath })));
    }
    if (view === "calendar") {
      const now = new Date(), end = new Date(now.getTime() + 14 * 86400_000);
      const cal = await sonarrApi(`calendar?start=${now.toISOString()}&end=${end.toISOString()}`);
      return textResult(cal.map((e: any) => ({ series: e.series?.title, episode: `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`, title: e.title, airDate: e.airDateUtc, hasFile: e.hasFile })));
    }
    if (view === "missing") {
      const data = await sonarrApi(`wanted/missing?pageSize=${limit}&sortKey=airDateUtc&sortDirection=descending`);
      return textResult({ total: data.totalRecords, episodes: data.records.map((e: any) => ({ series: e.series?.title, episode: `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`, title: e.title, airDate: e.airDateUtc })) });
    }
    if (view === "queue") {
      const q = await sonarrApi("queue");
      return textResult({ total: q.totalRecords, items: (q.records || []).map((r: any) => ({ series: r.series?.title, episode: r.episode ? `S${String(r.episode.seasonNumber).padStart(2, "0")}E${String(r.episode.episodeNumber).padStart(2, "0")}` : null, status: r.status, progress: r.sizeleft ? `${((1 - r.sizeleft / r.size) * 100).toFixed(0)}%` : "?", size: `${(r.size / 1073741824).toFixed(1)}GB` })) });
    }
    const h = await sonarrApi(`history?pageSize=${limit}`);
    return textResult(h.records.map((r: any) => ({ event: r.eventType, title: r.sourceTitle, date: r.date?.slice(0, 16), quality: r.quality?.quality?.name })));
  });

  server.registerTool("series_remove", {
    description: "Remove a series from Sonarr",
    inputSchema: {
      seriesId: z.number(), deleteFiles: z.boolean().default(false),
    },
  }, async ({ seriesId, deleteFiles }) => {
    const s = await sonarrApi(`series/${seriesId}`);
    await sonarrApi(`series/${seriesId}?deleteFiles=${deleteFiles}`, "DELETE");
    return textResult({ message: `Removed "${s.title}"${deleteFiles ? " + files" : ""}` });
  });

  server.registerTool("series_releases", {
    description: "Search available torrent releases for an episode or season. Shows size, languages, seeders, score.",
    inputSchema: {
      episodeId: z.number().optional().describe("Episode ID for specific episode"),
      seriesId: z.number().optional().describe("Series ID (use with seasonNumber for full season)"),
      seasonNumber: z.number().optional(),
    },
  }, async ({ episodeId, seriesId, seasonNumber }) => {
    let ep = "release?";
    if (episodeId) ep += `episodeId=${episodeId}`;
    else if (seriesId && seasonNumber !== undefined) ep += `seriesId=${seriesId}&seasonNumber=${seasonNumber}`;
    else if (seriesId) ep += `seriesId=${seriesId}`;
    else throw new Error("Provide episodeId or seriesId");
    const rels = await sonarrApi(ep);
    return textResult(rels.slice(0, 20).map((r: any) => ({
      guid: r.guid, title: r.title, quality: r.quality?.quality?.name, size: `${(r.size / 1073741824).toFixed(1)}GB`,
      seeders: r.seeders, languages: r.languages?.map((l: any) => l.name), indexer: r.indexer, indexerId: r.indexerId,
      score: r.customFormatScore, rejected: r.rejected || undefined, rejections: r.rejections?.length ? r.rejections.map((j: any) => j.reason) : undefined,
    })));
  });

  server.registerTool("series_grab", {
    description: "Download a specific torrent release for a series episode",
    inputSchema: {
      guid: z.string(), indexerId: z.number(),
    },
  }, async ({ guid, indexerId }) => {
    await sonarrApi("release", "POST", { guid, indexerId });
    return textResult({ message: "Release sent to download client" });
  });
}
