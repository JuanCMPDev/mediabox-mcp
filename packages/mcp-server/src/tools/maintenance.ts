import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { jfApi, sonarrApi, radarrApi, textResult } from "../helpers/api.js";
import { execFileAsync, resolvePath } from "../helpers/files.js";
import { jobs, startJob, estimateTime } from "../helpers/jobs.js";
import { issueConfirmToken, consumeConfirmToken } from "../helpers/confirm-tokens.js";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";

export function registerMaintenanceTools(server: McpServer): void {
  // 21. OPTIMIZE MEDIA
  server.registerTool("optimize_media", {
    description: "Analyze or strip unwanted audio/subtitle tracks from MKV files to save space. Works on single file or entire folder (batch). action='optimize' is a two-step flow: the first call returns a preview + confirmToken; show it to the user, then re-call with the same args and confirmToken to actually re-encode.",
    inputSchema: {
      mediaPath: z.string().describe("Path to media file or folder (e.g. 'anime/Invincible (2021)' or full path '/data/anime/Invincible (2021)')"),
      action: z.enum(["analyze", "optimize"]).default("analyze").describe("analyze = show tracks, optimize = strip unwanted tracks"),
      keepAudioLangs: z.array(z.string()).optional().describe("Audio languages to KEEP (e.g. ['spa', 'eng', 'jpn']). Others are removed. Omit to keep all."),
      keepSubLangs: z.array(z.string()).optional().describe("Subtitle languages to KEEP (e.g. ['spa', 'eng']). Omit to keep all."),
      removeAllSubs: z.boolean().default(false).describe("Remove ALL subtitle tracks"),
      confirmToken: z.string().optional().describe("Token returned from a prior preview call. Required to actually execute action='optimize'. Bound to the original args."),
    },
  }, async ({ mediaPath, action, keepAudioLangs, keepSubLangs, removeAllSubs, confirmToken }) => {
    const fullPath = resolvePath(mediaPath);
    const stat = await fs.stat(fullPath);
    const mkvs: string[] = [];
    if (stat.isFile() && fullPath.endsWith(".mkv")) mkvs.push(fullPath);
    else if (stat.isDirectory()) {
      async function find(d: string) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) await find(f); else if (e.name.endsWith(".mkv")) mkvs.push(f); } }
      await find(fullPath);
    }
    if (!mkvs.length) return textResult({ message: "No MKV files found" });

    // Read-only ffprobe pass over each mkv. Reused by the action='analyze'
    // path AND the action='optimize' preview path that runs when no
    // confirmToken is supplied.
    async function runAnalyze(): Promise<any[]> {
      const out: any[] = [];
      for (const mkv of mkvs.sort()) {
        try {
          const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", mkv], { timeout: 30_000 });
          const probe = JSON.parse(stdout);
          const streams = probe.streams || [];
          const fileSize = parseInt(probe.format?.size || "0");
          const tracks = streams.map((s: any, i: number) => ({
            index: i,
            type: s.codec_type,
            codec: s.codec_name,
            language: s.tags?.language || "und",
            title: s.tags?.title || "",
            channels: s.channels,
            default: s.disposition?.default === 1,
          }));
          out.push({
            file: path.basename(mkv),
            size: `${(fileSize / 1048576).toFixed(0)}MB`,
            tracks: tracks.map((t: any) => `[${t.index}] ${t.type} ${t.codec} lang=${t.language} ${t.title ? `"${t.title}"` : ""} ${t.channels ? `${t.channels}ch` : ""} ${t.default ? "(default)" : ""}`),
          });
        } catch (e: any) {
          out.push({ file: path.basename(mkv), status: `error: ${e.message.slice(0, 80)}` });
        }
      }
      return out;
    }

    // Token gate for action="optimize". Missing token returns the analyze
    // preview + a fresh token bound to these exact args; the LLM shows the
    // user what tracks would be dropped and re-calls with the token to
    // commit. Invalid/expired token aborts.
    const optimizeArgs = { mediaPath, keepAudioLangs, keepSubLangs, removeAllSubs };
    if (action === "optimize") {
      if (confirmToken) {
        if (!consumeConfirmToken("optimize_media.optimize", confirmToken, optimizeArgs)) {
          throw new Error("Invalid or expired confirmToken — re-call action='analyze' (or action='optimize' without confirmToken) to get a fresh preview.");
        }
        // valid token: fall through to execute
      } else {
        const preview = await runAnalyze();
        const token = issueConfirmToken("optimize_media.optimize", optimizeArgs);
        return textResult({
          requiresConfirmation: true,
          confirmToken: token,
          mode: "PREVIEW (no changes made)",
          files: mkvs.length,
          results: preview,
          message: `Will re-encode ${mkvs.length} MKV file(s) to drop the unwanted tracks shown above. Confirm with the user, then re-call optimize_media with action='optimize', the same args, and confirmToken='${token}'. Token expires in 5 min.`,
        });
      }
    }

    if (action === "analyze") {
      return textResult({ mode: "analyze", files: mkvs.length, results: await runAnalyze() });
    }

    if (mkvs.length > 3 && action === "optimize") {
      const est = estimateTime(mkvs.length * 1500 * 1048576, "ffmpeg");
      const job = startJob("optimize_media", async (j) => {
        const res: any[] = [];
        for (let i = 0; i < mkvs.length; i++) {
          const mkv = mkvs[i];
          j.message = `Optimizing ${i + 1}/${mkvs.length}: ${path.basename(mkv)}`;
          try {
            const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", mkv], { timeout: 30_000 });
            const probe = JSON.parse(stdout);
            const streams = probe.streams || [];
            const fileSize = parseInt(probe.format?.size || "0");
            const mapArgs: string[] = [];
            for (const t of streams) {
              if (t.codec_type === "video") mapArgs.push("-map", `0:${t.index}`);
              else if (t.codec_type === "audio") { if (!keepAudioLangs || keepAudioLangs.includes(t.tags?.language)) mapArgs.push("-map", `0:${t.index}`); }
              else if (t.codec_type === "subtitle") { if (!removeAllSubs && (!keepSubLangs || keepSubLangs.includes(t.tags?.language))) mapArgs.push("-map", `0:${t.index}`); }
              else mapArgs.push("-map", `0:${t.index}`);
            }
            if (mapArgs.length / 2 === streams.length) { res.push({ file: path.basename(mkv), status: "skipped" }); continue; }
            const tmp = mkv + ".opt.mkv";
            await execFileAsync("ffmpeg", ["-i", mkv, ...mapArgs, "-c", "copy", "-y", tmp], { timeout: 600_000 });
            const newStat = await fs.stat(tmp);
            await fs.unlink(mkv); await fs.rename(tmp, mkv);
            res.push({ file: path.basename(mkv), status: "optimized", saved: `${((fileSize - newStat.size) / 1048576).toFixed(0)}MB` });
          } catch (e: any) { await fs.unlink(mkv + ".opt.mkv").catch(() => {}); res.push({ file: path.basename(mkv), status: `error` }); }
        }
        const totalSaved = res.reduce((s, r) => s + (parseInt(r.saved) || 0), 0);
        j.message = `Completed: ${res.filter(r => r.status === "optimized").length}/${mkvs.length} optimized, saved ${totalSaved}MB`;
        j.result = res;
      });
      return textResult({ message: `Optimization started in background (${mkvs.length} files, ${est})`, jobId: job.id, tip: "Use check_jobs to monitor" });
    }

    // Inline optimize path (≤3 files). Larger batches were dispatched to a
    // background job above. We only get here with action="optimize" AND a
    // valid confirmToken consumed.
    const results: any[] = [];

    for (const mkv of mkvs.sort()) {
      try {
        const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", mkv], { timeout: 30_000 });
        const probe = JSON.parse(stdout);
        const streams = probe.streams || [];
        const fileSize = parseInt(probe.format?.size || "0");

        const tracks = streams.map((s: any, i: number) => ({
          index: i,
          type: s.codec_type,
          codec: s.codec_name,
          language: s.tags?.language || "und",
          title: s.tags?.title || "",
          channels: s.channels,
          default: s.disposition?.default === 1,
        }));

        const mapArgs: string[] = [];
        for (const t of tracks) {
          if (t.type === "video") {
            mapArgs.push("-map", `0:${t.index}`);
          } else if (t.type === "audio") {
            if (!keepAudioLangs || keepAudioLangs.includes(t.language) || keepAudioLangs.includes(t.language.slice(0, 3))) {
              mapArgs.push("-map", `0:${t.index}`);
            }
          } else if (t.type === "subtitle") {
            if (removeAllSubs) continue;
            if (!keepSubLangs || keepSubLangs.includes(t.language) || keepSubLangs.includes(t.language.slice(0, 3))) {
              mapArgs.push("-map", `0:${t.index}`);
            }
          } else {
            mapArgs.push("-map", `0:${t.index}`);
          }
        }

        if (mapArgs.length / 2 === tracks.length) {
          results.push({ file: path.basename(mkv), status: "skipped (nothing to remove)" });
          continue;
        }

        const tmp = mkv + ".opt.mkv";
        await execFileAsync("ffmpeg", ["-i", mkv, ...mapArgs, "-c", "copy", "-y", tmp], { timeout: 600_000 });
        const newStat = await fs.stat(tmp);
        const saved = fileSize - newStat.size;
        await fs.unlink(mkv);
        await fs.rename(tmp, mkv);

        results.push({
          file: path.basename(mkv),
          status: "optimized",
          before: `${(fileSize / 1048576).toFixed(0)}MB`,
          after: `${(newStat.size / 1048576).toFixed(0)}MB`,
          saved: `${(saved / 1048576).toFixed(0)}MB`,
        });
      } catch (e: any) {
        await fs.unlink(mkv + ".opt.mkv").catch(() => {});
        results.push({ file: path.basename(mkv), status: `error: ${e.message.slice(0, 80)}` });
      }
    }

    const totalSaved = results.reduce((sum, r) => sum + (parseInt(r.saved) || 0), 0);
    return textResult({
      mode: "optimize",
      files: mkvs.length,
      results,
      totalSaved: `${totalSaved}MB`,
    });
  });

  // 22. CLEANUP SERVER
  server.registerTool("cleanup_server", {
    description: "Clean up the server: remove Jellyfin cache, temp files, orphan downloads, ghost entries in Sonarr/Radarr, and qBittorrent completed torrents. Two-step flow: dryRun=false without confirmToken returns a preview + a fresh token; show the report to the user, then re-call dryRun=false with that token to apply.",
    inputSchema: {
      dryRun: z.boolean().default(true).describe("Preview what would be cleaned without deleting"),
      confirmToken: z.string().optional().describe("Token returned from a prior preview call. Required to actually execute (dryRun=false)."),
    },
  }, async ({ dryRun, confirmToken }) => {
    // Token gate. dryRun=true is unchanged (read-only preview). dryRun=false
    // requires a valid token; without one we force dryRun=true for this run
    // and attach a fresh token so the LLM can show the user and re-call.
    let effectiveDryRun = dryRun;
    let issuedToken: string | undefined;
    if (!dryRun) {
      if (confirmToken) {
        if (!consumeConfirmToken("cleanup_server.apply", confirmToken, {})) {
          throw new Error("Invalid or expired confirmToken — call cleanup_server with dryRun=false (and no confirmToken) to get a fresh preview.");
        }
        // valid token: stay with dryRun=false
      } else {
        effectiveDryRun = true;
        issuedToken = issueConfirmToken("cleanup_server.apply", {});
      }
    }
    dryRun = effectiveDryRun;

    const report: { action: string; size?: string; status: string }[] = [];

    // 1. Jellyfin cache
    try {
      report.push({ action: "Jellyfin cache", size: "check via Jellyfin WebUI", status: "info" });
    } catch {}

    // 2. Temp files in MCP container
    try {
      const tmpFiles: string[] = [];
      const entries = await fs.readdir("/tmp").catch(() => []);
      for (const e of entries) {
        if (e.startsWith("download-") || e.startsWith("extract-") || e.startsWith("pyload-")) {
          const full = `/tmp/${e}`;
          const stat = await fs.stat(full).catch(() => null);
          if (stat) {
            const sizeMB = stat.isDirectory() ? 0 : stat.size / 1048576;
            tmpFiles.push(full);
            if (!dryRun) await fs.rm(full, { recursive: true, force: true });
            report.push({ action: `Temp: ${e}`, size: `${sizeMB.toFixed(0)}MB`, status: dryRun ? "would delete" : "deleted" });
          }
        }
      }
      if (!tmpFiles.length) report.push({ action: "Temp files", status: "clean" });
    } catch {}

    // 3. Downloads folder
    try {
      const dlEntries = await fs.readdir(DOWNLOADS_PATH);
      if (dlEntries.length) {
        for (const e of dlEntries) {
          const full = path.join(DOWNLOADS_PATH, e);
          const stat = await fs.stat(full);
          const sizeMB = stat.size / 1048576;
          if (!dryRun) await fs.rm(full, { recursive: true, force: true });
          report.push({ action: `Download: ${e}`, size: `${sizeMB.toFixed(0)}MB`, status: dryRun ? "would delete" : "deleted" });
        }
      } else {
        report.push({ action: "Downloads folder", status: "clean" });
      }
    } catch {}

    // 4. Ghost series in Sonarr
    try {
      const series = await sonarrApi("series");
      for (const s of series) {
        const exists = await fs.stat(s.path).catch(() => null);
        if (!exists) {
          if (!dryRun) await sonarrApi(`series/${s.id}?deleteFiles=false`, "DELETE");
          report.push({ action: `Sonarr ghost: "${s.title}" (${s.path})`, status: dryRun ? "would remove" : "removed" });
        }
      }
    } catch {}

    // 5. Ghost movies in Radarr
    try {
      const movies = await radarrApi("movie");
      for (const m of movies) {
        const exists = await fs.stat(m.path).catch(() => null);
        if (!exists && !m.hasFile) {
          if (!dryRun) await radarrApi(`movie/${m.id}?deleteFiles=false`, "DELETE");
          report.push({ action: `Radarr ghost: "${m.title}" (${m.path})`, status: dryRun ? "would remove" : "removed" });
        }
      }
    } catch {}

    // 6. Disk usage
    let disk = "";
    try { disk = (await execFileAsync("df", ["-h", MEDIA_PATH])).stdout; } catch {}

    const wouldFree = report.filter(r => r.status.includes("would") || r.status === "deleted")
      .reduce((sum, r) => sum + (parseInt(r.size || "0") || 0), 0);

    return textResult({
      mode: dryRun ? "DRY RUN (no changes)" : "APPLIED",
      report,
      potentialSaved: `${wouldFree}MB`,
      disk,
      ...(issuedToken
        ? {
            requiresConfirmation: true,
            confirmToken: issuedToken,
            message: `Preview only — re-call cleanup_server with dryRun=false and confirmToken='${issuedToken}' to apply. Token expires in 5 min.`,
          }
        : {}),
    });
  });

  // 23. CHECK JOBS
  server.registerTool("check_jobs", {
    description: "Check status of background operations (moves, optimizations, etc.)",
    inputSchema: {
      jobId: z.string().optional().describe("Specific job ID. Omit to see all active jobs."),
    },
  }, async ({ jobId }) => {
    if (jobId) {
      const job = jobs.get(jobId);
      if (!job) return textResult({ error: "Job not found or expired" });
      return textResult(job);
    }
    const active: Record<string, any> = {};
    jobs.forEach((v, k) => { active[k] = v; });
    return textResult({ totalJobs: jobs.size, jobs: active });
  });
}
