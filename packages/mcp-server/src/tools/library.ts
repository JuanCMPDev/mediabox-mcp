import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { jfApi, sonarrApi, radarrApi, textResult } from "../helpers/api.js";
import { pyloadApi, pyloadApiJson } from "../helpers/pyload.js";
import { execFileAsync, moveFile, isVideoFile, extractEpisodeNumber, resolvePath } from "../helpers/files.js";
import { startJob, estimateTime } from "../helpers/jobs.js";
import { issueConfirmToken, consumeConfirmToken } from "../helpers/confirm-tokens.js";
import { MEDIA_PATH } from "../config.js";

export function registerLibraryTools(server: McpServer): void {
  // 5. MANAGE LIBRARY
  server.registerTool("manage_library", {
    description: "Create a library, trigger scan, or refresh metadata for an item",
    inputSchema: {
      action: z.enum(["scan", "create", "refresh_metadata"]).describe("Action to perform"),
      name: z.string().optional().describe("Library name (for create)"),
      type: z.enum(["movies", "tvshows", "music", "mixed"]).optional().describe("Library type (for create)"),
      folder: z.string().optional().describe("Folder path (for create, e.g. '/data/anime')"),
      itemId: z.string().optional().describe("Item ID (for refresh_metadata)"),
    },
  }, async ({ action, name, type, folder, itemId }) => {
    if (action === "scan") { await jfApi("/Library/Refresh", "POST"); return textResult({ message: "Library scan started" }); }
    if (action === "create") {
      if (!name || !type || !folder) throw new Error("name, type, and folder required");
      await fs.mkdir(folder, { recursive: true });
      await jfApi(`/Library/VirtualFolders?collectionType=${type}&refreshLibrary=true&name=${encodeURIComponent(name)}&paths=${encodeURIComponent(folder)}`, "POST", { LibraryOptions: {} });
      return textResult({ message: `Library "${name}" created at ${folder}` });
    }
    if (action === "refresh_metadata" && itemId) {
      await jfApi(`/Items/${itemId}/Refresh?MetadataRefreshMode=FullRefresh&ImageRefreshMode=FullRefresh&ReplaceAllMetadata=true&ReplaceAllImages=true`, "POST");
      return textResult({ message: `Metadata refresh started for ${itemId}` });
    }
    throw new Error("Invalid action or missing parameters");
  });

  // 6. MANAGE FILES
  server.registerTool("manage_files", {
    description: "List, move, or delete files and folders. Paths starting with 'downloads/' access the downloads folder. All other paths are relative to media volume. DELETE is a two-step flow: the first call returns a preview + confirmToken; show the preview to the user, then re-call with the same target and confirmToken to actually delete.",
    inputSchema: {
      action: z.enum(["list", "move", "delete"]).describe("Action to perform"),
      path: z.string().optional().describe("Path (e.g. 'anime/Show', 'downloads/', 'movies/')"),
      sourcePaths: z.array(z.string()).optional().describe("Source paths for move (e.g. ['downloads/file.mkv', 'tv/Show1'])"),
      destFolder: z.string().optional().describe("Destination folder for move (e.g. 'movies/Movie Name')"),
      jellyfinItemId: z.string().optional().describe("Jellyfin item ID to delete (also removes files)"),
      confirmToken: z.string().optional().describe("Token returned from a prior preview call. Required to actually execute a delete. Bound to the original target — re-issue if you change jellyfinItemId or path."),
    },
  }, async ({ action, path: filePath, sourcePaths, destFolder, jellyfinItemId, confirmToken }) => {
    if (action === "list") {
      const full = filePath ? resolvePath(filePath) : MEDIA_PATH;
      const entries = await fs.readdir(full, { withFileTypes: true });
      const items = await Promise.all(entries.map(async (e) => {
        const s = await fs.stat(path.join(full, e.name)).catch(() => null);
        return { name: e.name, type: e.isDirectory() ? "dir" : "file", size: s ? `${(s.size / 1024 / 1024).toFixed(1)}MB` : "?" };
      }));
      return textResult({ path: filePath || "/", items });
    }
    if (action === "move") {
      if (!sourcePaths?.length || !destFolder) throw new Error("sourcePaths and destFolder required");
      let totalSize = 0;
      for (const sp of sourcePaths) {
        const src = resolvePath(sp);
        try {
          const stat = await fs.stat(src);
          if (stat.isDirectory()) {
            const { stdout } = await execFileAsync("du", ["-sb", src], { timeout: 10_000 });
            totalSize += parseInt(stdout.split("\t")[0]) || 0;
          } else totalSize += stat.size;
        } catch {}
      }

      if (totalSize > 2_147_483_648) {
        const est = estimateTime(totalSize, "move");
        const job = startJob("move", async (j) => {
          const destDir = resolvePath(destFolder);
          await fs.mkdir(destDir, { recursive: true });
          const results: string[] = [];
          for (const sp of sourcePaths) {
            const src = resolvePath(sp), name = path.basename(src), dest = path.join(destDir, name);
            j.message = `Moving ${name}...`;
            try { await fs.rename(src, dest); } catch (e: any) {
              if (e.code === "EXDEV") { await execFileAsync("cp", ["-r", src, dest], { timeout: 1800_000 }); await fs.rm(src, { recursive: true, force: true }); } else throw e;
            }
            results.push(`${sp} → ${destFolder}/${name}`);
          }
          await jfApi("/Library/Refresh", "POST");
          j.message = "Move completed";
          j.result = results;
        });
        return textResult({ message: `Move started in background (${(totalSize / 1073741824).toFixed(1)}GB, ${est})`, jobId: job.id, tip: "Use check_jobs to monitor progress" });
      }

      const destDir = resolvePath(destFolder);
      await fs.mkdir(destDir, { recursive: true });
      const results: string[] = [];
      for (const sp of sourcePaths) {
        const src = resolvePath(sp), name = path.basename(src), dest = path.join(destDir, name);
        try { await fs.rename(src, dest); } catch (e: any) {
          if (e.code === "EXDEV") { await execFileAsync("cp", ["-r", src, dest], { timeout: 600_000 }); await fs.rm(src, { recursive: true, force: true }); } else throw e;
        }
        results.push(`${sp} → ${destFolder}/${name}`);
      }
      await jfApi("/Library/Refresh", "POST");
      return textResult({ message: "Moved", results });
    }
    if (action === "delete") {
      // 1. Input validation — fail fast on missing/unsafe args before any
      //    lookup or token issuance.
      if (!jellyfinItemId && !filePath) throw new Error("Provide jellyfinItemId or path");
      const fullPath = filePath ? resolvePath(filePath) : null;  // throws PathSandboxError on traversal
      const target = jellyfinItemId
        ? { kind: "jellyfin" as const, id: jellyfinItemId }
        : { kind: "path" as const, path: filePath };

      // 2. Token gate. With a token, we consume + execute. Without, we
      //    build a preview and return a fresh token so the LLM can show
      //    the user what's about to be deleted and confirm verbally.
      if (confirmToken) {
        if (!consumeConfirmToken("manage_files.delete", confirmToken, target)) {
          throw new Error("Invalid or expired confirmToken — re-issue by calling delete again without confirmToken to get a new preview.");
        }
        // fall through to execute
      } else {
        if (jellyfinItemId) {
          const lookup = await jfApi(`/Items?ids=${jellyfinItemId}&Fields=Path`);
          const item = lookup.Items?.[0];
          if (!item) throw new Error("Item not found");
          const token = issueConfirmToken("manage_files.delete", target);
          return textResult({
            requiresConfirmation: true,
            confirmToken: token,
            preview: { kind: "jellyfin", id: item.Id, name: item.Name, type: item.Type, path: item.Path },
            // Note: the literal token is NOT in this message string — it
            // travels in the confirmToken field above. Including it here
            // would leak it into the LLM's user-facing reply (observed Apr
            // 30: GPT-4o paraphrased the token verbatim and asked the user
            // to "resend the request with this token").
            message: `Preview only — nothing has been deleted. Will delete "${item.Name}" (${item.Type}) from Jellyfin + Sonarr/Radarr + disk. Show this preview to the user. If they confirm, YOU (the assistant) re-call manage_files with the same args plus confirmToken from this response. Never expose confirmToken to the user.`,
          });
        }
        // path branch
        const stat = await fs.stat(fullPath!).catch(() => null);
        if (!stat) throw new Error(`Path not found: ${filePath}`);
        const token = issueConfirmToken("manage_files.delete", target);
        return textResult({
          requiresConfirmation: true,
          confirmToken: token,
          preview: {
            kind: "path",
            path: filePath,
            isDirectory: stat.isDirectory(),
            sizeBytes: stat.size,
          },
          message: `Preview only — nothing has been deleted. Will delete ${stat.isDirectory() ? "directory" : "file"} ${filePath} (${(stat.size / 1048576).toFixed(1)}MB). Show this to the user. If they confirm, YOU (the assistant) re-call manage_files with the same args plus confirmToken from this response. Never expose confirmToken to the user.`,
        });
      }

      // 3. Execute (token was valid).
      if (jellyfinItemId) {
        const lookup = await jfApi(`/Items?ids=${jellyfinItemId}&Fields=Path`);
        const item = lookup.Items?.[0];
        if (!item) throw new Error("Item not found");

        // Delete files from disk BEFORE removing from Jellyfin
        if (item.Path) {
          const dir = item.Type === "Series" || item.Type === "BoxSet" ? item.Path : path.dirname(item.Path);
          await fs.rm(dir, { recursive: true, force: true });
        }

        await jfApi(`/Items/${jellyfinItemId}`, "DELETE").catch(() => {});

        if (item.Type === "Series") {
          try {
            const sonarrSeries = await sonarrApi("series");
            const match = sonarrSeries.find((s: any) => s.title === item.Name || item.Path?.includes(s.path));
            if (match) await sonarrApi(`series/${match.id}?deleteFiles=true`, "DELETE");
          } catch {}
        }

        if (item.Type === "Movie") {
          try {
            const radarrMovies = await radarrApi("movie");
            const match = radarrMovies.find((m: any) => m.title === item.Name || item.Path?.includes(m.path));
            if (match) await radarrApi(`movie/${match.id}?deleteFiles=true`, "DELETE");
          } catch {}
        }

        // Clean matching PyLoad packages (finished/failed leftovers)
        try {
          const nameLower = item.Name.toLowerCase();
          for (const getter of ["get_queue", "get_collector"]) {
            const pkgs = await pyloadApi(getter);
            if (!Array.isArray(pkgs)) continue;
            const matchIds = pkgs.filter((p: any) => p.name?.toLowerCase().includes(nameLower)).map((p: any) => p.pid);
            if (matchIds.length) await pyloadApiJson("deletePackages", { package_ids: matchIds });
          }
        } catch {}

        await jfApi("/Library/Refresh", "POST");
        return textResult({ message: `Deleted "${item.Name}" (${item.Type}) from Jellyfin, Sonarr/Radarr, and disk` });
      }
      // path branch — fullPath was resolved + sandbox-checked at step 1
      await fs.rm(fullPath!, { recursive: true, force: true });
      await jfApi("/Library/Refresh", "POST");
      return textResult({ message: `Deleted ${filePath}` });
    }
    throw new Error("Invalid action");
  });

  // 7. RENAME EPISODES
  server.registerTool("rename_episodes", {
    description: "Rename episode files to Jellyfin standard format. Searches recursively. You can pass jellyfinItemId instead of showPath — the tool resolves the path from Jellyfin automatically. Use search_media first to find the item ID if needed.",
    inputSchema: {
      showPath: z.string().optional().describe("Path to show folder (e.g. 'anime/Samurai X' or full path '/data/anime/Samurai X'). Optional if jellyfinItemId is provided."),
      jellyfinItemId: z.string().optional().describe("Jellyfin item ID — resolves the file path automatically"),
      showName: z.string().describe("Correct show name for renamed files (e.g. 'Rurouni Kenshin')"),
      seasonNumber: z.number().default(1),
      startEpisodeNumber: z.number().default(1).describe("Starting episode number for the sequence (default 1)"),
      dryRun: z.boolean().default(true).describe("Preview changes without applying"),
    },
  }, async ({ showPath, jellyfinItemId, showName, seasonNumber, startEpisodeNumber, dryRun }) => {
    if (!showPath && jellyfinItemId) {
      const lookup = await jfApi(`/Items?ids=${jellyfinItemId}`);
      const item = lookup.Items?.[0];
      if (!item?.Path) throw new Error("Item not found or has no path");
      const itemPath = item.Type === "Series" ? item.Path : path.dirname(item.Path);
      showPath = path.relative(MEDIA_PATH, itemPath);
    }
    if (!showPath) throw new Error("Provide showPath or jellyfinItemId");
    const fullPath = resolvePath(showPath);
    const seasonPad = String(seasonNumber).padStart(2, "0");
    const seasonDir = path.join(fullPath, `Season ${seasonPad}`);
    const vids: { fullPath: string; name: string }[] = [];
    async function find(dir: string) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) await find(f); else if (isVideoFile(e.name)) vids.push({ fullPath: f, name: e.name }); } }
    await find(fullPath);
    if (!vids.length) return textResult({ message: "No video files found", path: showPath });
    vids.sort((a, b) => extractEpisodeNumber(a.name) - extractEpisodeNumber(b.name));
    const renames = vids.map((v, i) => ({ from: v.fullPath.replace(fullPath + "/", ""), to: `${showName} - S${seasonPad}E${String(startEpisodeNumber + i).padStart(2, "0")}${path.extname(v.name)}` }));
    if (!dryRun) {
      await fs.mkdir(seasonDir, { recursive: true });
      for (let i = 0; i < vids.length; i++) {
        const destPath = path.join(seasonDir, renames[i].to);
        const exists = await fs.stat(destPath).catch(() => null);
        if (exists && exists.isFile()) {
          throw new Error(`Collision detected: ${destPath} already exists. Aborting rename to prevent data loss.`);
        }
        await moveFile(vids[i].fullPath, destPath);
      }
      await jfApi("/Library/Refresh", "POST");
    }
    return textResult({ mode: dryRun ? "DRY RUN" : "APPLIED", files: vids.length, renames });
    });

    server.registerTool("get_library_state", {
    description: "Unified view of media status. Checks if a show/movie exists in Jellyfin, Sonarr/Radarr, and if it's being downloaded. Perfect for finding gaps.",
    inputSchema: {
      query: z.string().describe("Search term (e.g. 'Dragon Ball', 'Inception')"),
      type: z.enum(["Series", "Movie"]).default("Series"),
    },
    }, async ({ query, type }) => {
    const results: any = { query, type, jellyfin: null, arr: null, queue: [] };

    // 1. Jellyfin
    try {
      const jf = await jfApi(`/Items?searchTerm=${encodeURIComponent(query)}&IncludeItemTypes=${type === "Series" ? "Series" : "Movie"}&Recursive=true&Fields=Path,ProviderIds`);
      results.jellyfin = jf.Items?.map((i: any) => ({ id: i.Id, name: i.Name, year: i.ProductionYear, hasFile: !!i.Path }));
    } catch {}

    // 2. Arrs
    if (type === "Series") {
      try {
        const series = await sonarrApi("series");
        const match = series.find((s: any) => s.title.toLowerCase().includes(query.toLowerCase()));
        if (match) {
          results.arr = {
            id: match.id, title: match.title, status: match.status, monitored: match.monitored,
            episodes: `${match.episodeFileCount}/${match.episodeCount}`, path: match.path,
          };
          const q = await sonarrApi("queue");
          results.queue = (q.records || []).filter((r: any) => r.seriesId === match.id).map((r: any) => ({ status: r.status, progress: r.sizeleft ? `${((1 - r.sizeleft / r.size) * 100).toFixed(0)}%` : "?" }));
        }
      } catch {}
    } else {
      try {
        const movies = await radarrApi("movie");
        const match = movies.find((m: any) => m.title.toLowerCase().includes(query.toLowerCase()));
        if (match) {
          results.arr = {
            id: match.id, title: match.title, status: match.status, monitored: match.monitored,
            hasFile: match.hasFile, path: match.path,
          };
          const q = await radarrApi("queue");
          results.queue = (q.records || []).filter((r: any) => r.movieId === match.id).map((r: any) => ({ status: r.status, progress: r.sizeleft ? `${((1 - r.sizeleft / r.size) * 100).toFixed(0)}%` : "?" }));
        }
      } catch {}
    }

    return textResult(results);
  });

  // 8. FIX SUBTITLES
  server.registerTool("fix_subtitles", {
    description: "Convert ASS/SSA subtitles to SRT in MKV files to prevent transcoding. Works on single file or entire folder.",
    inputSchema: {
      mediaPath: z.string().describe("Path to media file or folder (e.g. 'anime/Show' or full path '/data/anime/Show')"),
      dryRun: z.boolean().default(true),
    },
  }, async ({ mediaPath, dryRun }) => {
    const fullPath = resolvePath(mediaPath);
    const stat = await fs.stat(fullPath);
    const mkvs: string[] = [];
    if (stat.isFile() && fullPath.endsWith(".mkv")) mkvs.push(fullPath);
    else if (stat.isDirectory()) { async function find(d: string) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await find(f); else if (e.name.endsWith(".mkv")) mkvs.push(f); } } await find(fullPath); }
    if (!mkvs.length) return textResult({ message: "No MKV files found" });

    if (mkvs.length > 3 && !dryRun) {
      const est = estimateTime(mkvs.length * 800 * 1048576, "ffmpeg");
      const job = startJob("fix_subtitles", async (j) => {
        const res: any[] = [];
        for (let i = 0; i < mkvs.length; i++) {
          const mkv = mkvs[i];
          j.message = `Processing ${i + 1}/${mkvs.length}: ${path.basename(mkv)}`;
          try {
            const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "s", mkv], { timeout: 30_000 });
            const assTracks = (JSON.parse(stdout).streams || []).filter((s: any) => s.codec_name === "ass" || s.codec_name === "ssa");
            if (!assTracks.length) { res.push({ file: path.basename(mkv), status: "skipped" }); continue; }
            const allStreams = JSON.parse((await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", mkv], { timeout: 30_000 })).stdout);
            const args = ["-i", mkv, "-map", "0", "-c:v", "copy", "-c:a", "copy"];
            let si = 0;
            for (const s of allStreams.streams || []) { if (s.codec_type === "subtitle") { args.push(`-c:s:${si}`, (s.codec_name === "ass" || s.codec_name === "ssa") ? "srt" : "copy"); si++; } }
            const tmp = mkv + ".tmp.mkv"; args.push("-y", tmp);
            await execFileAsync("ffmpeg", args, { timeout: 600_000 });
            await fs.unlink(mkv); await fs.rename(tmp, mkv);
            res.push({ file: path.basename(mkv), status: "converted" });
          } catch (e: any) { await fs.unlink(mkv + ".tmp.mkv").catch(() => {}); res.push({ file: path.basename(mkv), status: `error: ${e.message.slice(0, 60)}` }); }
        }
        j.message = `Completed: ${res.filter(r => r.status === "converted").length}/${mkvs.length} converted`;
        j.result = res;
      });
      return textResult({ message: `Subtitle fix started in background (${mkvs.length} files, ${est})`, jobId: job.id, tip: "Use check_jobs to monitor" });
    }

    const results: { file: string; assTracks: number; status: string }[] = [];
    for (const mkv of mkvs.sort()) {
      try {
        const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "s", mkv], { timeout: 30_000 });
        const assTracks = (JSON.parse(stdout).streams || []).filter((s: any) => s.codec_name === "ass" || s.codec_name === "ssa");
        if (!assTracks.length) { results.push({ file: path.basename(mkv), assTracks: 0, status: "skipped (no ASS)" }); continue; }
        if (dryRun) { results.push({ file: path.basename(mkv), assTracks: assTracks.length, status: "HAS ASS — would convert" }); continue; }
        const allStreams = JSON.parse((await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", mkv], { timeout: 30_000 })).stdout);
        const args = ["-i", mkv, "-map", "0", "-c:v", "copy", "-c:a", "copy"];
        let si = 0;
        for (const s of allStreams.streams || []) { if (s.codec_type === "subtitle") { args.push(`-c:s:${si}`, (s.codec_name === "ass" || s.codec_name === "ssa") ? "srt" : "copy"); si++; } }
        const tmp = mkv + ".tmp.mkv";
        args.push("-y", tmp);
        await execFileAsync("ffmpeg", args, { timeout: 600_000 });
        await fs.unlink(mkv);
        await fs.rename(tmp, mkv);
        results.push({ file: path.basename(mkv), assTracks: assTracks.length, status: "converted ASS → SRT" });
      } catch (e: any) { await fs.unlink(mkv + ".tmp.mkv").catch(() => {}); results.push({ file: path.basename(mkv), assTracks: 0, status: `error: ${e.message.slice(0, 80)}` }); }
    }
    return textResult({ mode: dryRun ? "DRY RUN" : "APPLIED", total: mkvs.length, results });
  });
}
