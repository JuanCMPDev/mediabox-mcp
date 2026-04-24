import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { radarrApi, textResult } from "../helpers/api.js";

export function registerRadarrTools(server: McpServer): void {
  server.registerTool("movie_search", {
    description: "Search for a movie and optionally add it to Radarr for monitoring. Use searchNow=false (default) to add without auto-downloading, letting you pick a release manually via movie_releases + movie_grab.",
    inputSchema: {
      query: z.string().optional().describe("Movie name to search. Required for search, optional when adding by ID."),
      addTmdbId: z.number().optional().describe("TMDB ID to add (from search results). Omit to just search."),
      quality: z.enum(["Any", "SD", "HD-720p", "HD-1080p", "Ultra-HD", "HD - 720p/1080p"]).default("HD-1080p"),
      searchNow: z.boolean().default(false).describe("Trigger automatic download search after adding. Default false to allow manual release selection."),
    },
  }, async ({ query, addTmdbId, quality, searchNow }) => {
    if (!addTmdbId) {
      if (!query) throw new Error("query is required when not adding by ID");
      const results = await radarrApi(`movie/lookup?term=${encodeURIComponent(query)}`);
      return textResult(results.slice(0, 10).map((m: any) => ({ title: m.title, year: m.year, tmdbId: m.tmdbId, overview: m.overview?.slice(0, 120), runtime: m.runtime ? `${m.runtime}min` : null, status: m.status })));
    }
    const existing = (await radarrApi("movie")).find((m: any) => m.tmdbId === addTmdbId);
    const profiles = await radarrApi("qualityprofile");
    const profile = profiles.find((p: any) => p.name === quality) || profiles[0];

    if (existing) {
      existing.monitored = true;
      existing.qualityProfileId = profile.id;
      await radarrApi(`movie/${existing.id}`, "PUT", existing);
      if (searchNow) await radarrApi("command", "POST", { name: "MoviesSearch", movieIds: [existing.id] });
      return textResult({ message: `Updated "${existing.title}" monitoring${searchNow ? ", searching" : ""}`, id: existing.id, searchNow });
    }
    const lookup = await radarrApi(`movie/lookup?term=tmdb:${addTmdbId}`);
    if (!lookup.length) throw new Error("Movie not found");
    const result = await radarrApi("movie", "POST", { ...lookup[0], rootFolderPath: "/movies", qualityProfileId: profile.id, monitored: true, minimumAvailability: "released", addOptions: { searchForMovie: searchNow } });
    return textResult({ message: `Added "${result.title}" (${result.year})${searchNow ? " — searching" : ""}`, id: result.id, quality: profile.name, searchNow });
  });

  server.registerTool("movie_status", {
    description: "View monitored movies, queue, or download history",
    inputSchema: {
      view: z.enum(["movies", "queue", "history"]).default("movies"), limit: z.number().default(20),
    },
  }, async ({ view, limit }) => {
    if (view === "movies") {
      const movies = await radarrApi("movie");
      return textResult(movies.map((m: any) => ({ id: m.id, title: m.title, year: m.year, monitored: m.monitored, hasFile: m.hasFile, size: m.sizeOnDisk ? `${(m.sizeOnDisk / 1073741824).toFixed(1)}GB` : "0GB", status: m.status })));
    }
    if (view === "queue") {
      const q = await radarrApi("queue");
      return textResult({ total: q.totalRecords, items: (q.records || []).map((r: any) => ({ movie: r.movie?.title, status: r.status, progress: r.sizeleft ? `${((1 - r.sizeleft / r.size) * 100).toFixed(0)}%` : "?", size: `${(r.size / 1073741824).toFixed(1)}GB` })) });
    }
    const h = await radarrApi(`history?pageSize=${limit}`);
    return textResult(h.records.map((r: any) => ({ event: r.eventType, title: r.sourceTitle, date: r.date?.slice(0, 16), quality: r.quality?.quality?.name })));
  });

  server.registerTool("movie_remove", {
    description: "Remove a movie from Radarr",
    inputSchema: {
      movieId: z.number(), deleteFiles: z.boolean().default(false),
    },
  }, async ({ movieId, deleteFiles }) => {
    const m = await radarrApi(`movie/${movieId}`);
    await radarrApi(`movie/${movieId}?deleteFiles=${deleteFiles}`, "DELETE");
    return textResult({ message: `Removed "${m.title}"${deleteFiles ? " + files" : ""}` });
  });

  server.registerTool("movie_releases", {
    description: "Search available torrent releases for a movie. Shows size, languages, seeders, score.",
    inputSchema: {
      movieId: z.number(),
    },
  }, async ({ movieId }) => {
    const rels = await radarrApi(`release?movieId=${movieId}`);
    return textResult(rels.slice(0, 20).map((r: any) => ({
      guid: r.guid, title: r.title, quality: r.quality?.quality?.name, size: `${(r.size / 1073741824).toFixed(1)}GB`,
      seeders: r.seeders, languages: r.languages?.map((l: any) => l.name), indexer: r.indexer, indexerId: r.indexerId,
      score: r.customFormatScore, rejected: r.rejected || undefined, rejections: r.rejections?.length ? r.rejections.map((j: any) => j.reason) : undefined,
    })));
  });

  server.registerTool("movie_grab", {
    description: "Download a specific torrent release for a movie. Automatically cancels any existing download for the same movie to avoid duplicates.",
    inputSchema: {
      guid: z.string(), indexerId: z.number(),
      movieId: z.number().optional().describe("Movie ID — if provided, cancels any active download for this movie before grabbing"),
    },
  }, async ({ guid, indexerId, movieId }) => {
    if (movieId) {
      const q = await radarrApi("queue?pageSize=200");
      const dupes = (q.records || []).filter((r: any) => r.movieId === movieId);
      if (dupes.length) {
        await radarrApi("queue/bulk?removeFromClient=true&blocklist=false", "DELETE", { ids: dupes.map((r: any) => r.id) } as any);
      }
    }
    await radarrApi("release", "POST", { guid, indexerId });
    return textResult({ message: "Release sent to download client", replaced: movieId ? true : undefined });
  });

  server.registerTool("movie_import", {
    description: "Import manual downloads into Radarr library. action='list' shows detected mappings, action='import' applies them. Use this for PyLoad or other manual movie downloads.",
    inputSchema: {
      action: z.enum(["list", "import"]).default("list"),
      folder: z.string().describe("Folder in downloads to import from (e.g. 'downloads/Movie Title')"),
      movieId: z.number().optional().describe("Force import for this Radarr movie ID"),
      files: z.array(z.object({
        path: z.string(),
        movieId: z.number(),
        quality: z.object({ quality: z.object({ id: z.number() }) }).optional(),
      })).optional().describe("Selected file mappings (for action='import')"),
    },
  }, async ({ action, folder, movieId, files }) => {
    const fullFolder = resolvePath(folder);
    if (action === "list") {
      const ep = `manualimport?folder=${encodeURIComponent(fullFolder)}${movieId ? `&movieId=${movieId}` : ""}`;
      const results = await radarrApi(ep);
      return textResult(results.map((r: any) => ({
        path: r.path.replace(DOWNLOADS_PATH, "downloads"),
        movie: r.movie?.title,
        movieId: r.movie?.id,
        quality: r.quality?.quality?.name,
        rejection: r.rejections?.[0]?.reason,
      })));
    }
    if (!files?.length) throw new Error("files mapping required for import");
    await radarrApi("manualimport", "POST", { files, importMode: "move" });
    return textResult({ message: `Imported ${files.length} movie(s) into Radarr` });
  });

  server.registerTool("movie_rescan", {
    description: "Force Radarr to rescan movie folders or a specific movie for new files.",
    inputSchema: {
      movieId: z.number().optional().describe("Radarr movie ID. If omitted, rescans all movies."),
    },
  }, async ({ movieId }) => {
    const cmd = movieId ? { name: "RescanMovie", movieIds: [movieId] } : { name: "RescanMovie" };
    await radarrApi("command", "POST", cmd);
    return textResult({ message: `Rescan command sent${movieId ? ` for movie ${movieId}` : ""}` });
  });
}

import { resolvePath } from "../helpers/files.js";
import { DOWNLOADS_PATH } from "../config.js";
