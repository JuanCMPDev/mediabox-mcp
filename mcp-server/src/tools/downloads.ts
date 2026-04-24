import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { jfApi, sonarrApi, radarrApi, textResult } from "../helpers/api.js";
import { pyloadApi, pyloadApiJson } from "../helpers/pyload.js";
import { qbitApi } from "../helpers/qbittorrent.js";
import { execFileAsync, moveFile, isVideoFile, isArchiveFile, extractArchive, detectAndFixExtension } from "../helpers/files.js";
import { startJob, jobs } from "../helpers/jobs.js";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";

export const SUBTITLE_EXT = new Set([".srt", ".ass", ".ssa", ".vtt", ".sub", ".idx"]);

export function registerDownloadTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // DOWNLOAD ADD — Add URLs to PyLoad
  // -------------------------------------------------------------------------
  server.registerTool("download_add", {
    description: "Add URLs to PyLoad for downloading from file hosters (Mega, MediaFire, etc.). Use a descriptive packageName — it becomes the subfolder in downloads.",
    inputSchema: {
      urls: z.array(z.string()),
      packageName: z.string().describe("Descriptive name (e.g. 'Pet Sematary 1989'). Becomes the download folder name."),
    },
  }, async ({ urls, packageName }) => {
    const normalized = urls.map(u => u.replace("depositfiles.org", "depositfiles.com"));
    const result = await pyloadApi("add_package", "POST", { name: JSON.stringify(packageName), links: JSON.stringify(normalized) });
    return textResult({
      message: `Added ${urls.length} URL(s) as "${packageName}"`,
      packageId: result,
      nextSteps: `Monitor with download_status. Once finished, organize with download_status action=organize, packageFolder="${packageName}", showName="...", libraryFolder=movies|tv|anime`,
    });
  });

  // -------------------------------------------------------------------------
  // DOWNLOAD STATUS — Check PyLoad, organize to Jellyfin, or delete packages
  // -------------------------------------------------------------------------
  server.registerTool("download_status", {
    description: `PyLoad download manager. Three actions:
- status: shows PyLoad queue AND lists folders in /downloads/ ready to organize
- organize: moves downloaded files to Jellyfin library (runs async for archives). For movies use libraryFolder="movies", for series use libraryFolder="tv" or "anime" with seasonNumber.
- delete: removes packages from PyLoad queue by their package IDs`,
    inputSchema: {
      action: z.enum(["status", "organize", "delete"]).default("status"),
      // For delete
      packageIds: z.array(z.number()).optional().describe("PyLoad package IDs to delete"),
      // For organize
      packageFolder: z.string().optional().describe("Folder name in /downloads/ to organize (from status response's downloadFolders)"),
      showName: z.string().optional().describe("Target name in Jellyfin (e.g. 'Pet Sematary (1989)')"),
      libraryFolder: z.enum(["tv", "movies", "music", "anime"]).default("movies"),
      seasonNumber: z.number().optional().describe("Season number (only for tv/anime)"),
      episodeNumber: z.number().optional().describe("Starting episode number (only for tv/anime)"),
      archivePassword: z.string().optional().describe("Password for RAR/ZIP/7z archives"),
    },
  }, async ({ action, packageIds, packageFolder, showName, libraryFolder, seasonNumber, episodeNumber, archivePassword }) => {

    // === STATUS ===
    if (action === "status") {
      let pyloadQueue: any[] = [];
      let pyloadFinished: any[] = [];
      let activeDownloads: any[] = [];
      let serverStatus: any = null;
      try {
        const [queue, collector, status, downloads] = await Promise.all([
          pyloadApi("get_queue"), pyloadApi("get_collector"), pyloadApi("statusServer"), pyloadApi("statusDownloads"),
        ]);
        pyloadQueue = Array.isArray(queue) ? queue : [];
        pyloadFinished = Array.isArray(collector) ? collector : [];
        activeDownloads = Array.isArray(downloads) ? downloads : [];
        serverStatus = status;
      } catch {}

      let downloadFolders: string[] = [];
      try {
        const entries = await fs.readdir(DOWNLOADS_PATH);
        downloadFolders = entries;
      } catch {}

      // Also show any running organize jobs
      const activeJobs: any[] = [];
      jobs.forEach((j) => { if (j.type === "organize_downloads" && j.status === "running") activeJobs.push({ id: j.id, status: j.status, message: j.message }); });

      // Build real-time download map from statusDownloads
      const dlMap = new Map(activeDownloads.map((d: any) => [d.package_id, d]));

      const mapPkg = (p: any) => {
        const dl = dlMap.get(p.pid);
        if (dl) return {
          id: p.pid, name: p.name, status: "downloading",
          fileName: dl.name, progress: `${dl.percent}%`,
          speed: `${(dl.speed / 1048576).toFixed(1)}MB/s`,
          eta: dl.format_eta, size: dl.format_size,
        };
        const done = p.linksdone === p.linkstotal && p.linkstotal > 0;
        return {
          id: p.pid, name: p.name,
          status: done ? "finished" : "queued",
          size: p.sizetotal > 0 ? `${(p.sizetotal / 1048576).toFixed(0)}MB` : "unknown",
          linksDone: `${p.linksdone}/${p.linkstotal}`,
        };
      };

      return textResult({
        pyload: {
          downloading: serverStatus?.active || 0,
          speed: serverStatus?.speed ? `${(serverStatus.speed / 1048576).toFixed(1)}MB/s` : "0",
          paused: serverStatus?.pause || false,
        },
        activeDownloads: pyloadQueue.map(mapPkg),
        finishedPackages: pyloadFinished.map((p: any) => ({
          id: p.pid, name: p.name, status: "finished",
          size: p.sizetotal > 0 ? `${(p.sizetotal / 1048576).toFixed(0)}MB` : "unknown",
        })),
        downloadFolders,
        activeJobs: activeJobs.length ? activeJobs : undefined,
        help: "Wait until activeDownloads shows 'finished' before organizing. Use folder names from downloadFolders as packageFolder for organize.",
      });
    }

    // === DELETE ===
    if (action === "delete") {
      if (!packageIds?.length) return textResult({ error: "Provide packageIds to delete. Use action=status to see available IDs." });
      await pyloadApiJson("deletePackages", { package_ids: packageIds });
      return textResult({ message: `Deleted ${packageIds.length} package(s) from PyLoad` });
    }

    // === ORGANIZE ===
    if (!packageFolder) return textResult({ error: "packageFolder required. Use action=status to see downloadFolders." });
    if (!showName) return textResult({ error: "showName required (e.g. 'Pet Sematary (1989)')" });

    const searchDir = path.join(DOWNLOADS_PATH, packageFolder);
    try { await fs.stat(searchDir); } catch {
      // Maybe files are directly in downloads root (not in subfolder)
      const rootFiles = await fs.readdir(DOWNLOADS_PATH).catch(() => []);
      return textResult({ error: `Folder "${packageFolder}" not found in downloads.`, availableFolders: rootFiles });
    }

    // Determine destination
    let destDir: string;
    if (libraryFolder === "movies") {
      destDir = path.join(MEDIA_PATH, "movies", showName);
    } else {
      const seasonPad = String(seasonNumber || 1).padStart(2, "0");
      destDir = path.join(MEDIA_PATH, libraryFolder, showName, `Season ${seasonPad}`);
    }

    // Run as background job
    const job = startJob("organize_downloads", async (j) => {
      await fs.mkdir(destDir, { recursive: true });
      const allFiles: string[] = [];
      async function find(dir: string) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) await find(f); else allFiles.push(f); } }
      await find(searchDir);
      if (!allFiles.length) { j.message = "No files found in folder"; j.status = "failed"; return; }

      const results: string[] = [];
      const isMovie = libraryFolder === "movies";
      const seasonPad = String(seasonNumber || 1).padStart(2, "0");
      const startEp = episodeNumber || 1;
      let epCounter = 0;

      const MIN_VIDEO_SIZE = 5 * 1024 * 1024; // 5MB — anything smaller is likely junk (HTML pages, broken downloads)
      const skipped: string[] = [];

      for (const fp of allFiles.sort()) {
        j.message = `Processing ${path.basename(fp)}...`;
        const fixed = await detectAndFixExtension(fp);
        if (isArchiveFile(fixed)) {
          const extractDir = path.join("/tmp", `extract-${crypto.randomUUID()}`);
          await fs.mkdir(extractDir, { recursive: true });
          j.message = `Extracting ${path.basename(fixed)}${archivePassword ? " (with password)" : ""}...`;
          const vids = await extractArchive(fixed, extractDir, archivePassword);
          vids.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
          for (const v of vids) {
            const vStat = await fs.stat(v).catch(() => null);
            if (!vStat || vStat.size < MIN_VIDEO_SIZE) { skipped.push(`${path.basename(v)} (too small: ${vStat ? Math.round(vStat.size / 1024) + 'KB' : '0'})`); continue; }
            const ext = path.extname(v).toLowerCase();
            const destName = isMovie
              ? `${showName}${ext}`
              : `${showName} - S${seasonPad}E${String(startEp + epCounter++).padStart(2, "0")}${ext}`;
            await moveFile(v, path.join(destDir, destName));
            results.push(destName);

            // Look for matching subtitle files in the same extraction dir
            const baseName = path.basename(v, ext);
            const parentDir = path.dirname(v);
            for (const f of await fs.readdir(parentDir)) {
              if (f.startsWith(baseName) && SUBTITLE_EXT.has(path.extname(f).toLowerCase())) {
                const subDest = isMovie ? `${showName}${path.extname(f)}` : `${showName} - S${seasonPad}E${String(startEp + epCounter - 1).padStart(2, "0")}${path.extname(f)}`;
                await moveFile(path.join(parentDir, f), path.join(destDir, subDest));
              }
            }
          }
          await fs.unlink(fixed).catch(() => {});
          await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        } else if (isVideoFile(fixed)) {
          const fStat = await fs.stat(fixed).catch(() => null);
          if (!fStat || fStat.size < MIN_VIDEO_SIZE) { skipped.push(`${path.basename(fixed)} (too small: ${fStat ? Math.round(fStat.size / 1024) + 'KB' : '0'})`); continue; }
          const ext = path.extname(fixed).toLowerCase();
          const destName = isMovie
            ? `${showName}${ext}`
            : `${showName} - S${seasonPad}E${String(startEp + epCounter++).padStart(2, "0")}${ext}`;
          await moveFile(fixed, path.join(destDir, destName));
          results.push(destName);

          // Look for matching subtitle files in the same source dir
          const baseName = path.basename(fixed, ext);
          const parentDir = path.dirname(fixed);
          for (const f of await fs.readdir(parentDir)) {
            if (f.startsWith(baseName) && SUBTITLE_EXT.has(path.extname(f).toLowerCase())) {
              const subDest = isMovie ? `${showName}${path.extname(f)}` : `${showName} - S${seasonPad}E${String(startEp + epCounter - 1).padStart(2, "0")}${path.extname(f)}`;
              await moveFile(path.join(parentDir, f), path.join(destDir, subDest));
            }
          }
        }
      }

      if (!results.length) { j.message = `No valid video files found${skipped.length ? `. Skipped: ${skipped.join(', ')}` : ''}`; j.status = "failed"; return; }
      await fs.rm(searchDir, { recursive: true, force: true }).catch(() => {});
      await jfApi("/Library/Refresh", "POST");

      // Trigger Rescan in Sonarr/Radarr if possible
      if (libraryFolder === "movies") {
        try {
          const movies = await radarrApi("movie");
          const match = movies.find((m: any) => m.title.toLowerCase().includes(showName.toLowerCase()) || m.path.toLowerCase().includes(showName.toLowerCase()));
          if (match) await radarrApi("command", "POST", { name: "RescanMovie", movieIds: [match.id] });
        } catch {}
      } else {
        try {
          const series = await sonarrApi("series");
          const match = series.find((s: any) => s.title.toLowerCase().includes(showName.toLowerCase()) || s.path.toLowerCase().includes(showName.toLowerCase()));
          if (match) await sonarrApi("command", "POST", { name: "RescanSeries", seriesId: match.id });
        } catch {}
      }

      j.message = `Done — ${results.length} file(s) added to ${libraryFolder}/${showName} (Library rescan triggered)`;
      j.result = { destination: destDir, files: results };
    });

    return textResult({
      message: `Organizing "${packageFolder}" → ${libraryFolder}/${showName}`,
      jobId: job.id,
      note: "Use download_status action=status to see job progress (shown in activeJobs), or check_jobs with this jobId.",
    });
  });

  // -------------------------------------------------------------------------
  // DOWNLOAD DIRECT — aria2c/yt-dlp for direct URLs and video sites
  // -------------------------------------------------------------------------
  server.registerTool("download_direct", {
    description: "Download a file from a direct URL (or YouTube/video site via yt-dlp) and optionally organize it into Jellyfin. Use this instead of download_add for direct HTTP links, Google Drive, and YouTube-supported sites. Runs as a background job.",
    inputSchema: {
      url: z.string().describe("Direct URL to download (HTTP link, YouTube, Google Drive, etc.)"),
      showName: z.string().describe("Target name in Jellyfin (e.g. 'Tears of Steel (2012)')"),
      libraryFolder: z.enum(["tv", "movies", "music", "anime"]).default("movies"),
      seasonNumber: z.number().optional().describe("Season number (only for tv/anime)"),
      episodeNumber: z.number().optional().describe("Starting episode number (only for tv/anime)"),
    },
  }, async ({ url, showName, libraryFolder, seasonNumber, episodeNumber }) => {
    const isYtDlp = /youtu|vimeo|dailymotion|twitch|twitter|reddit/i.test(url);
    const tmpDir = path.join("/tmp", `dl-${crypto.randomUUID().slice(0, 8)}`);

    const job = startJob("download_direct", async (j) => {
      await fs.mkdir(tmpDir, { recursive: true });

      // Download
      if (isYtDlp) {
        j.message = `Downloading with yt-dlp...`;
        await execFileAsync("yt-dlp", ["-o", `${tmpDir}/%(title)s.%(ext)s`, "--no-playlist", url], { timeout: 1800_000 });
      } else {
        j.message = `Downloading with aria2c...`;
        await execFileAsync("aria2c", ["-d", tmpDir, "-x", "8", "-s", "8", "--file-allocation=none", url], { timeout: 1800_000 });
      }

      // Find downloaded files
      const files = await fs.readdir(tmpDir);
      if (!files.length) { j.message = "Download produced no files"; j.status = "failed"; return; }

      // Determine destination
      let destDir: string;
      if (libraryFolder === "movies") {
        destDir = path.join(MEDIA_PATH, "movies", showName);
      } else {
        const seasonPad = String(seasonNumber || 1).padStart(2, "0");
        destDir = path.join(MEDIA_PATH, libraryFolder, showName, `Season ${seasonPad}`);
      }
      await fs.mkdir(destDir, { recursive: true });

      // Move files
      j.message = "Organizing files...";
      const results: string[] = [];
      const isMovie = libraryFolder === "movies";
      const seasonPad = String(seasonNumber || 1).padStart(2, "0");
      let epCounter = 0;

      for (const file of files.sort()) {
        const src = path.join(tmpDir, file);
        const fixed = await detectAndFixExtension(src);

        if (isArchiveFile(fixed)) {
          const extractDir = path.join("/tmp", `extract-${crypto.randomUUID().slice(0, 8)}`);
          await fs.mkdir(extractDir, { recursive: true });
          j.message = `Extracting ${path.basename(fixed)}...`;
          const vids = await extractArchive(fixed, extractDir);
          for (const v of vids.sort()) {
            const ext = path.extname(v).toLowerCase();
            const destName = isMovie
              ? `${showName}${ext}`
              : `${showName} - S${seasonPad}E${String((episodeNumber || 1) + epCounter++).padStart(2, "0")}${ext}`;
            await moveFile(v, path.join(destDir, destName));
            results.push(destName);

            // Subtitles
            const baseName = path.basename(v, ext);
            const pDir = path.dirname(v);
            for (const f of await fs.readdir(pDir)) {
              if (f.startsWith(baseName) && SUBTITLE_EXT.has(path.extname(f).toLowerCase())) {
                const subDest = isMovie ? `${showName}${path.extname(f)}` : `${showName} - S${seasonPad}E${String((episodeNumber || 1) + epCounter - 1).padStart(2, "0")}${path.extname(f)}`;
                await moveFile(path.join(pDir, f), path.join(destDir, subDest));
              }
            }
          }
          await fs.unlink(fixed).catch(() => {});
          await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        } else if (isVideoFile(fixed)) {
          const ext = path.extname(fixed).toLowerCase();
          const destName = isMovie
            ? `${showName}${ext}`
            : `${showName} - S${seasonPad}E${String((episodeNumber || 1) + epCounter++).padStart(2, "0")}${ext}`;
          await moveFile(fixed, path.join(destDir, destName));
          results.push(destName);

          // Subtitles
          const baseName = path.basename(fixed, ext);
          const pDir = path.dirname(fixed);
          for (const f of await fs.readdir(pDir)) {
            if (f.startsWith(baseName) && SUBTITLE_EXT.has(path.extname(f).toLowerCase())) {
              const subDest = isMovie ? `${showName}${path.extname(f)}` : `${showName} - S${seasonPad}E${String((episodeNumber || 1) + epCounter - 1).padStart(2, "0")}${path.extname(f)}`;
              await moveFile(path.join(pDir, f), path.join(destDir, subDest));
            }
          }
        } else {
          // Non-video file (subtitle, nfo, etc.) — move as-is
          await moveFile(fixed, path.join(destDir, path.basename(fixed)));
          results.push(path.basename(fixed));
        }
      }

      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await jfApi("/Library/Refresh", "POST");
      j.message = `Done — ${results.length} file(s) added to ${libraryFolder}/${showName}`;
      j.result = { destination: destDir, files: results };
    });

    return textResult({
      message: `Downloading ${isYtDlp ? "via yt-dlp" : "via aria2c"} → ${libraryFolder}/${showName}`,
      jobId: job.id,
      note: "Use download_status action=status to see job progress, or check_jobs with this jobId.",
    });
  });

  // -------------------------------------------------------------------------
  // CANCEL DOWNLOADS — Sonarr/Radarr/qBittorrent queue management
  // -------------------------------------------------------------------------
  server.registerTool("cancel_downloads", {
    description: "Manage Sonarr/Radarr/qBittorrent download queues. NOT for PyLoad — use download_status action=delete for PyLoad packages.",
    inputSchema: {
      source: z.enum(["sonarr", "radarr", "qbittorrent"]).describe("Which queue to manage"),
      action: z.enum(["list", "cancel", "cancel_series", "purge_duplicates", "clean_orphans"]).default("list"),
      queueIds: z.array(z.number()).optional().describe("Sonarr/Radarr queue item IDs to cancel"),
      torrentHashes: z.array(z.string()).optional().describe("qBittorrent torrent hashes to delete"),
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
          message: `Removed ${orphans.length} orphan torrents`,
          removed: orphans.map((t: any) => ({ name: t.name, size: `${(t.size / 1073741824).toFixed(1)}GB` })),
        });
      }
      return textResult({ error: "For qBittorrent use: list, cancel, or clean_orphans" });
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
      return textResult({ message: `Cancelled ${queueIds.length} items from ${source}` });
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
