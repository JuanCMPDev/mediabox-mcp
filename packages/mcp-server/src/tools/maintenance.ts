import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { jfApi, sonarrApi, radarrApi, textResult } from "../helpers/api.js";
import { execFileAsync, resolvePath } from "../helpers/files.js";
import { jobs, startJob, estimateTime } from "../helpers/jobs.js";
import { issueConfirmToken, consumeConfirmToken } from "../helpers/confirm-tokens.js";
import { assertMutationAllowed } from "../helpers/containment.js";
import { MEDIA_PATH, DOWNLOADS_PATH } from "../config.js";
import { defaultOperationStore } from "../operations/default-store.js";
import { inspectMedia, listProfiles } from "../storage/media-jobs.js";
import { mapNamespace } from "../storage/namespace-map.js";
import { createMediaFormatPlan } from "../operations/planners/media-format.js";
import { createToolEnvelope } from "../queries/envelope.js";
import { runEnvelopeTool } from "../queries/tool-result.js";
import { defaultToolContext, resolvePlanScope, type McpToolContext } from "../security/context.js";

export function registerMaintenanceTools(server: McpServer, context: McpToolContext = defaultToolContext()): void {
  const scope = resolvePlanScope(context);

  server.registerTool("inspect_format", {
    description: "Inspect a media file with ffprobe: container, duration and every stream (type, codec, language). Read-only.",
    inputSchema: {
      path: z.string().describe("Logical path to the media file (e.g. 'anime/Show/ep01.mkv' or '/data/movies/film.mkv')"),
    },
  }, async ({ path: logicalPath }) =>
    runEnvelopeTool(async () => {
      const { rootId, relativePath } = mapNamespace(logicalPath);
      const probe = await inspectMedia({ rootId, relativePath });
      return createToolEnvelope({
        data: { path: `${rootId}:${relativePath}`, ...probe },
        sources: [{ source: "ffprobe", observedAt: new Date().toISOString(), completeness: "complete" }],
      });
    })
  );

  server.registerTool("propose_media_job", {
    description: "Propose a media format conversion job. Options for action: 'remux', 'subtitle-convert', 'transcode'. Profile names: e.g. 'cpu_av1_transcode', 'cpu_hevc_transcode'.",
    inputSchema: {
      path: z.string().describe("Logical path to the media file"),
      action: z.enum(["remux", "subtitle-convert", "transcode"]),
      profileName: z.string().optional().describe("Closed profile name (mkv_remux, srt_subtitles, cpu_hevc_transcode, cpu_av1_transcode); omit for the action default"),
    },
  }, async ({ path: logicalPath, action, profileName }) =>
    runEnvelopeTool(async () => {
      const { plan, summary } = await createMediaFormatPlan({ logicalPath, action, profileName, scope });
      const record = defaultOperationStore.createPlan(plan, "awaiting_approval");
      const effective = record.plan;
      const duplicate = effective.id !== plan.id;
      return createToolEnvelope({
        data: {
          planId: effective.id,
          operation: effective.operation,
          status: record.status,
          manifestHash: effective.manifestHash,
          expiresAt: effective.expiresAt,
          proposalKey: effective.proposalKey,
          duplicate,
          summary,
          availableProfiles: listProfiles(),
          message: duplicate
            ? `Plan ${effective.id} for this file and profile is already awaiting owner approval; no second plan was created.`
            : `Plan ${effective.id} awaits owner approval in the Mediabox app. Use operation_status to follow it.`,
        },
      });
    })
  );
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
        assertMutationAllowed("cleanup_server");
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
            // Token value lives in confirmToken field — do not interpolate
            // here; LLMs paraphrase the message and would leak the token.
            message: `Preview only — nothing has been cleaned. Show this report to the user. If they confirm, YOU (the assistant) re-call cleanup_server with dryRun=false plus confirmToken from this response. Never expose confirmToken to the user.`,
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

