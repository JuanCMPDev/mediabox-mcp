import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { jfApi, sonarrApi, radarrApi, textResult } from "../helpers/api.js";
import { pyloadApi } from "../helpers/pyload.js";
import { qbitApi } from "../helpers/qbittorrent.js";
import { moveFile, isVideoFile, isArchiveFile, extractArchive, detectAndFixExtension } from "../helpers/files.js";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";

export function registerDownloadTools(server: McpServer): void {
  // 19. DOWNLOAD ADD
  server.registerTool("download_add", {
    description: "Add URLs to PyLoad for downloading from file hosters (Mega, MediaFire, etc.)",
    inputSchema: {
      urls: z.array(z.string()), packageName: z.string().default("MCP Download"),
    },
  }, async ({ urls, packageName }) => {
    const normalized = urls.map(u => u.replace("depositfiles.org", "depositfiles.com"));
    const result = await pyloadApi("add_package", "POST", { name: JSON.stringify(packageName), links: JSON.stringify(normalized) });
    return textResult({ message: `Added ${urls.length} URL(s) as "${packageName}"`, packageId: result, tip: "Use download_status to monitor" });
  });

  // 20. DOWNLOAD STATUS
  server.registerTool("download_status", {
    description: "Check PyLoad download status. Can also organize completed downloads into Jellyfin library.",
    inputSchema: {
      organize: z.boolean().default(false).describe("Move completed downloads to library"),
      showName: z.string().optional().describe("Show/movie name for organizing"),
      seasonNumber: z.number().default(1).describe("Season number for organizing"),
      episodeNumber: z.number().optional().describe("Starting episode number"),
      libraryFolder: z.enum(["tv", "movies", "music", "anime"]).default("tv"),
      archivePassword: z.string().optional(),
      packageFolder: z.string().optional().describe("Specific subfolder in downloads"),
    },
  }, async ({ organize, showName, seasonNumber, episodeNumber, libraryFolder, archivePassword, packageFolder }) => {
    if (!organize) {
      const [status, queue] = await Promise.all([pyloadApi("status_server"), pyloadApi("get_queue")]);
      return textResult({ server: status, queue: Array.isArray(queue) ? queue.map((p: any) => ({ id: p.pid, name: p.name, links: p.links?.map((l: any) => ({ name: l.name, status: l.statusmsg, size: l.format_size })) })) : queue });
    }
    if (!showName) throw new Error("showName required for organize");
    const seasonPad = String(seasonNumber).padStart(2, "0");
    const seasonDir = path.join(MEDIA_PATH, libraryFolder, showName, `Season ${seasonPad}`);
    await fs.mkdir(seasonDir, { recursive: true });
    const searchDir = packageFolder ? path.join(DOWNLOADS_PATH, packageFolder) : DOWNLOADS_PATH;
    const allFiles: string[] = [];
    async function find(dir: string) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) await find(f); else allFiles.push(f); } }
    await find(searchDir);
    if (!allFiles.length) return textResult({ error: "No files in downloads" });

    const results: string[] = [];
    const startEp = episodeNumber || 1;
    let epCounter = 0;
    for (const fp of allFiles.sort()) {
      const fixed = await detectAndFixExtension(fp);
      if (isArchiveFile(fixed)) {
        const ext = path.join("/tmp", `extract-${crypto.randomUUID()}`);
        await fs.mkdir(ext, { recursive: true });
        const vids = await extractArchive(fixed, ext, archivePassword);
        vids.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
        for (const v of vids) { const n = `${showName} - S${seasonPad}E${String(startEp + epCounter).padStart(2, "0")}${path.extname(v)}`; await moveFile(v, path.join(seasonDir, n)); results.push(n); epCounter++; }
        await fs.unlink(fixed).catch(() => {});
        await fs.rm(ext, { recursive: true, force: true }).catch(() => {});
      } else if (isVideoFile(fixed)) {
        const n = `${showName} - S${seasonPad}E${String(startEp + epCounter).padStart(2, "0")}${path.extname(fixed)}`; await moveFile(fixed, path.join(seasonDir, n)); results.push(n); epCounter++;
      }
    }
    if (!results.length) return textResult({ error: "No video files found" });
    if (packageFolder) await fs.rm(path.join(DOWNLOADS_PATH, packageFolder), { recursive: true, force: true }).catch(() => {});
    await jfApi("/Library/Refresh", "POST");
    return textResult({ message: "Organized and scan triggered", destination: seasonDir, files: results });
  });

  // 24. CANCEL DOWNLOADS
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
