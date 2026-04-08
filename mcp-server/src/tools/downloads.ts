import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { jfApi, sonarrApi, radarrApi, textResult } from "../helpers/api.js";
import { pyloadApi } from "../helpers/pyload.js";
import { qbitApi } from "../helpers/qbittorrent.js";
import { moveFile, isVideoFile, isArchiveFile, extractArchive, detectAndFixExtension } from "../helpers/files.js";
import { startJob } from "../helpers/jobs.js";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";

export function registerDownloadTools(server: McpServer): void {
  server.registerTool("download_add", {
    description: "Add URLs to PyLoad for downloading from file hosters (Mega, MediaFire, etc.). Use a descriptive packageName — it becomes the subfolder name in downloads, which you'll need later for organizing.",
    inputSchema: {
      urls: z.array(z.string()),
      packageName: z.string().describe("Package name (becomes the download subfolder). Use the movie/show name, e.g. 'Pet Sematary 1989'"),
    },
  }, async ({ urls, packageName }) => {
    const normalized = urls.map(u => u.replace("depositfiles.org", "depositfiles.com"));
    const result = await pyloadApi("add_package", "POST", { name: JSON.stringify(packageName), links: JSON.stringify(normalized) });
    return textResult({
      message: `Added ${urls.length} URL(s) as "${packageName}"`,
      packageId: result,
      packageFolder: packageName,
      tip: "Use download_status to monitor. When done, use download_status with organize=true, packageFolder='" + packageName + "' to move to Jellyfin library.",
    });
  });

  server.registerTool("download_status", {
    description: "Check PyLoad download status, organize completed downloads into Jellyfin library, or delete PyLoad packages. For organize: pass the packageFolder (same as packageName from download_add), the target showName for Jellyfin, and archivePassword if the download is a password-protected archive. For movies, use libraryFolder='movies' and omit seasonNumber. Runs as background job for large files/archives.",
    inputSchema: {
      action: z.enum(["status", "organize", "delete"]).default("status").describe("status = check queue, organize = move to library, delete = remove PyLoad packages"),
      packageIds: z.array(z.number()).optional().describe("PyLoad package IDs to delete (for action=delete)"),
      showName: z.string().optional().describe("Movie or show name for Jellyfin (for organize)"),
      seasonNumber: z.number().optional().describe("Season number (for TV/anime organize). Omit for movies."),
      episodeNumber: z.number().optional().describe("Starting episode number (for TV/anime)"),
      libraryFolder: z.enum(["tv", "movies", "music", "anime"]).default("movies").describe("Target library folder"),
      archivePassword: z.string().optional().describe("Password for RAR/ZIP/7z archives"),
      packageFolder: z.string().optional().describe("Subfolder in downloads to organize (usually same as packageName from download_add)"),
    },
  }, async ({ action, packageIds, showName, seasonNumber, episodeNumber, libraryFolder, archivePassword, packageFolder }) => {
    // DELETE packages from PyLoad
    if (action === "delete") {
      if (!packageIds?.length) {
        // List packages so the caller can pick IDs
        const queue = await pyloadApi("get_queue");
        const collector = await pyloadApi("get_collector");
        const all = [...(Array.isArray(queue) ? queue : []), ...(Array.isArray(collector) ? collector : [])];
        return textResult({ message: "Provide packageIds to delete", packages: all.map((p: any) => ({ id: p.pid, name: p.name, status: p.statusmsg, links: p.links?.length })) });
      }
      for (const pid of packageIds) {
        await pyloadApi("delete_packages", "POST", { pids: JSON.stringify([pid]) });
      }
      return textResult({ message: `Deleted ${packageIds.length} package(s) from PyLoad` });
    }

    // STATUS
    if (action === "status") {
      const [status, queue] = await Promise.all([pyloadApi("status_server"), pyloadApi("get_queue")]);
      return textResult({
        server: status,
        queue: Array.isArray(queue) ? queue.map((p: any) => ({
          id: p.pid, name: p.name, folder: p.folder,
          links: p.links?.map((l: any) => ({ name: l.name, status: l.statusmsg, size: l.format_size })),
        })) : queue,
        tip: "Package 'folder' is the packageFolder you need for organize. Package 'id' is what you need for delete.",
      });
    }

    // ORGANIZE
    if (!showName) throw new Error("showName required for organize");

    // Determine destination
    let destDir: string;
    if (libraryFolder === "movies") {
      // Movies go directly into /data/movies/Movie Name/
      destDir = path.join(MEDIA_PATH, "movies", showName);
    } else {
      const seasonPad = String(seasonNumber || 1).padStart(2, "0");
      destDir = path.join(MEDIA_PATH, libraryFolder, showName, `Season ${seasonPad}`);
    }

    const searchDir = packageFolder ? path.join(DOWNLOADS_PATH, packageFolder) : DOWNLOADS_PATH;

    // Check if dir exists
    try { await fs.stat(searchDir); } catch { return textResult({ error: `Folder not found: ${packageFolder || "downloads/"}. Use download_status action=status to see available package folders.` }); }

    // Run as async job (archives can take minutes to extract)
    const job = startJob("organize_downloads", async (j) => {
      await fs.mkdir(destDir, { recursive: true });
      const allFiles: string[] = [];
      async function find(dir: string) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) await find(f); else allFiles.push(f); } }
      await find(searchDir);
      if (!allFiles.length) { j.message = "No files found"; j.status = "failed"; return; }

      const results: string[] = [];
      const isMovie = libraryFolder === "movies";
      const seasonPad = String(seasonNumber || 1).padStart(2, "0");
      const startEp = episodeNumber || 1;
      let epCounter = 0;

      for (const fp of allFiles.sort()) {
        j.message = `Processing ${path.basename(fp)}...`;
        const fixed = await detectAndFixExtension(fp);
        if (isArchiveFile(fixed)) {
          const extractDir = path.join("/tmp", `extract-${crypto.randomUUID()}`);
          await fs.mkdir(extractDir, { recursive: true });
          j.message = `Extracting ${path.basename(fixed)}...`;
          const vids = await extractArchive(fixed, extractDir, archivePassword);
          vids.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
          for (const v of vids) {
            let destName: string;
            if (isMovie) {
              destName = `${showName}${path.extname(v)}`;
            } else {
              destName = `${showName} - S${seasonPad}E${String(startEp + epCounter).padStart(2, "0")}${path.extname(v)}`;
              epCounter++;
            }
            await moveFile(v, path.join(destDir, destName));
            results.push(destName);
          }
          await fs.unlink(fixed).catch(() => {});
          await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        } else if (isVideoFile(fixed)) {
          let destName: string;
          if (isMovie) {
            destName = `${showName}${path.extname(fixed)}`;
          } else {
            destName = `${showName} - S${seasonPad}E${String(startEp + epCounter).padStart(2, "0")}${path.extname(fixed)}`;
            epCounter++;
          }
          await moveFile(fixed, path.join(destDir, destName));
          results.push(destName);
        }
      }

      if (!results.length) { j.message = "No video files found after processing"; j.status = "failed"; return; }

      // Clean up package folder
      if (packageFolder) await fs.rm(path.join(DOWNLOADS_PATH, packageFolder), { recursive: true, force: true }).catch(() => {});

      await jfApi("/Library/Refresh", "POST");
      j.message = `Organized ${results.length} file(s) to ${libraryFolder}/${showName}`;
      j.result = { destination: destDir, files: results };
    });

    return textResult({
      message: `Organizing in background — archives may take a few minutes to extract`,
      jobId: job.id,
      tip: "Use check_jobs to monitor progress",
    });
  });

  server.registerTool("cancel_downloads", {
    description: "Manage download queue: Sonarr/Radarr and qBittorrent. Cancel items, purge duplicates, or clean orphan torrents.",
    inputSchema: {
      source: z.enum(["sonarr", "radarr", "qbittorrent"]).describe("Which queue to manage"),
      action: z.enum(["list", "cancel", "cancel_series", "purge_duplicates", "clean_orphans"]).default("list"),
      queueIds: z.array(z.number()).optional().describe("Sonarr/Radarr queue item IDs to cancel"),
      torrentHashes: z.array(z.string()).optional().describe("qBittorrent torrent hashes to delete (from list)"),
      seriesId: z.number().optional().describe("Cancel all for this series"),
      movieId: z.number().optional().describe("Cancel all for this movie"),
    },
  }, async ({ source, action, queueIds, torrentHashes, seriesId, movieId }) => {

    if (source === "qbittorrent") {
      if (action === "cancel" && torrentHashes?.length) {
        const hashes = torrentHashes.join("|");
        await qbitApi("torrents/delete", "POST", { hashes, deleteFiles: "true" });
        return textResult({ message: `Deleted ${torrentHashes.length} torrent(s) from qBittorrent` });
      }
      if (action === "list") {
        const torrents = await qbitApi("torrents/info");
        return textResult(Array.isArray(torrents) ? torrents.map((t: any) => ({
          hash: t.hash, name: t.name, state: t.state,
          size: `${(t.size / 1073741824).toFixed(1)}GB`,
          progress: `${(t.progress * 100).toFixed(0)}%`,
          dlspeed: `${(t.dlspeed / 1048576).toFixed(1)}MB/s`,
          seeds: t.num_seeds,
        })) : []);
      }
      if (action === "clean_orphans") {
        const torrents = await qbitApi("torrents/info");
        if (!Array.isArray(torrents) || !torrents.length) return textResult({ message: "No torrents in qBittorrent" });
        const activeHashes = new Set<string>();
        try { const sq = await sonarrApi("queue?pageSize=200"); for (const r of sq.records || []) if (r.downloadId) activeHashes.add(r.downloadId.toLowerCase()); } catch {}
        try { const rq = await radarrApi("queue?pageSize=200"); for (const r of rq.records || []) if (r.downloadId) activeHashes.add(r.downloadId.toLowerCase()); } catch {}
        const orphans = torrents.filter((t: any) => !activeHashes.has(t.hash.toLowerCase()));
        if (!orphans.length) return textResult({ message: "No orphan torrents", total: torrents.length });
        const hashes = orphans.map((t: any) => t.hash).join("|");
        await qbitApi("torrents/delete", "POST", { hashes, deleteFiles: "true" });

        return textResult({
          message: `Removed ${orphans.length} orphan torrents from qBittorrent`,
          removed: orphans.map((t: any) => ({ name: t.name, size: `${(t.size / 1073741824).toFixed(1)}GB` })),
          kept: torrents.length - orphans.length,
        });
      }
      return textResult({ error: "For qBittorrent, use 'list' or 'clean_orphans'" });
    }

    const api = source === "sonarr" ? sonarrApi : radarrApi;

    if (action === "list") {
      const q = await api("queue?pageSize=100");
      return textResult({ total: q.totalRecords, items: (q.records || []).map((r: any) => ({
        id: r.id, title: r.title, series: r.series?.title || r.movie?.title, status: r.status,
        size: `${(r.size / 1073741824).toFixed(1)}GB`,
        progress: r.sizeleft ? `${((1 - r.sizeleft / r.size) * 100).toFixed(0)}%` : "?",
      }))});
    }

    if (action === "cancel" && queueIds?.length) {
      await api(`queue/bulk?removeFromClient=true&blocklist=false`, "DELETE", { ids: queueIds } as any);
      return textResult({ message: `Cancelled ${queueIds.length} items from ${source} + qBittorrent` });
    }

    if (action === "cancel_series") {
      const q = await api("queue?pageSize=200");
      const matching = (q.records || []).filter((r: any) => (seriesId && r.seriesId === seriesId) || (movieId && r.movieId === movieId));
      if (!matching.length) return textResult({ message: "No queue items found" });
      const ids = matching.map((r: any) => r.id);
      await api(`queue/bulk?removeFromClient=true&blocklist=false`, "DELETE", { ids } as any);
      return textResult({ message: `Cancelled ${ids.length} items` });
    }

    if (action === "purge_duplicates") {
      const q = await api("queue?pageSize=200");
      const groups = new Map<string, any[]>();
      for (const r of q.records || []) {
        const key = r.episodeId ? `ep-${r.episodeId}` : r.movieId ? `mov-${r.movieId}` : `t-${r.title}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      const toRemove: number[] = [];
      for (const [, items] of groups) {
        if (items.length <= 1) continue;
        items.sort((a: any, b: any) => (b.customFormatScore || 0) - (a.customFormatScore || 0) || (a.size || 0) - (b.size || 0));
        for (let i = 1; i < items.length; i++) toRemove.push(items[i].id);
      }
      if (!toRemove.length) return textResult({ message: "No duplicates found" });
      await api(`queue/bulk?removeFromClient=true&blocklist=false`, "DELETE", { ids: toRemove } as any);
      return textResult({ message: `Purged ${toRemove.length} duplicates`, kept: (q.records?.length || 0) - toRemove.length });
    }

    return textResult({ error: "Invalid action" });
  });
}
