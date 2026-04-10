import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { jfApi, sonarrApi, radarrApi, textResult } from "../helpers/api.js";
import { execFileAsync, moveFile, isVideoFile, extractEpisodeNumber, resolvePath } from "../helpers/files.js";
import { startJob, estimateTime } from "../helpers/jobs.js";
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
    description: "List, move, or delete files and folders. Paths starting with 'downloads/' access the downloads folder. All other paths are relative to media volume.",
    inputSchema: {
      action: z.enum(["list", "move", "delete"]).describe("Action to perform"),
      path: z.string().optional().describe("Path (e.g. 'anime/Show', 'downloads/', 'movies/')"),
      sourcePaths: z.array(z.string()).optional().describe("Source paths for move (e.g. ['downloads/file.mkv', 'tv/Show1'])"),
      destFolder: z.string().optional().describe("Destination folder for move (e.g. 'movies/Movie Name')"),
      jellyfinItemId: z.string().optional().describe("Jellyfin item ID to delete (also removes files)"),
    },
  }, async ({ action, path: filePath, sourcePaths, destFolder, jellyfinItemId }) => {
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

        await jfApi("/Library/Refresh", "POST");
        return textResult({ message: `Deleted "${item.Name}" (${item.Type}) from Jellyfin, Sonarr/Radarr, and disk` });
      }
      if (filePath) {
        const full = resolvePath(filePath);
        await fs.rm(full, { recursive: true, force: true });
        await jfApi("/Library/Refresh", "POST");
        return textResult({ message: `Deleted ${filePath}` });
      }
      throw new Error("Provide jellyfinItemId or path");
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
      dryRun: z.boolean().default(true).describe("Preview changes without applying"),
    },
  }, async ({ showPath, jellyfinItemId, showName, seasonNumber, dryRun }) => {
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
    const renames = vids.map((v, i) => ({ from: v.fullPath.replace(fullPath + "/", ""), to: `${showName} - S${seasonPad}E${String(i + 1).padStart(2, "0")}${path.extname(v.name)}` }));
    if (!dryRun) {
      await fs.mkdir(seasonDir, { recursive: true });
      for (let i = 0; i < vids.length; i++) await moveFile(vids[i].fullPath, path.join(seasonDir, renames[i].to));
      await jfApi("/Library/Refresh", "POST");
    }
    return textResult({ mode: dryRun ? "DRY RUN" : "APPLIED", files: vids.length, renames });
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
