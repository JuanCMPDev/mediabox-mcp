import type { OperationPlanRecord } from "@mediabox/contracts";
import { OperationExecutor, UnknownOutcomeError, type VerificationResult } from "./executor.js";
import {
  quarantineFile,
  removeEmptyDirectory,
  restoreQuarantined,
  purgeQuarantined,
  QUARANTINE_DIR_NAME,
} from "../storage/quarantine.js";
import { defaultRootFs } from "../storage/rootfs.js";
import { executeMediaJob, resolveProfile, type MediaAction } from "../storage/media-jobs.js";
import { sonarrApi, radarrApi } from "../helpers/api.js";
import { querySonarrSafe, queryRadarrSafe } from "../queries/clients.js";

/**
 * Step handlers and verifiers bound to the single executor (P04–P07).
 * Every handler re-derives its target from the approved plan (never from
 * model input), re-checks identity before an effect and reports what it
 * observed. Verifiers run in the `verifying` state before `succeeded`.
 */

const GRAB_TIMEOUT_MS = 20_000;

type DownloadService = "sonarr" | "radarr";

function paramString(params: Record<string, string | number | boolean> | undefined, key: string): string | undefined {
  const v = params?.[key];
  return v === undefined ? undefined : String(v);
}

function paramNumber(params: Record<string, string | number | boolean> | undefined, key: string): number | undefined {
  const v = params?.[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function serviceApi(service: DownloadService) {
  return service === "sonarr" ? sonarrApi : radarrApi;
}

function serviceQuery(service: DownloadService) {
  return service === "sonarr" ? querySonarrSafe : queryRadarrSafe;
}

export interface GrabReconciliation {
  found: boolean;
  /** Whether the service answered at all; false means the outcome cannot be verified. */
  serviceReachable: boolean;
  status?: "submitted" | "downloading";
  downloadId?: string;
  queueId?: number;
  historyId?: number;
}

/**
 * Reconciles a grab by stable identity: release guid in the grabbed history,
 * then the download client id in the queue. Titles are used only as a
 * secondary confirmation when the queue item belongs to the same entity.
 */
export async function reconcileGrab(
  service: DownloadService,
  guid: string,
  entityId?: number,
  releaseTitle?: string
): Promise<GrabReconciliation> {
  const query = serviceQuery(service);
  const [history, queue] = await Promise.all([
    query<any>("history?page=1&pageSize=50&sortKey=date&sortDirection=descending"),
    query<any>("queue?page=1&pageSize=200&includeUnknownSeriesItems=true&includeUnknownMovieItems=true"),
  ]);

  const historyReachable = history.sourceStatus.completeness === "complete";
  const queueReachable = queue.sourceStatus.completeness === "complete";

  let downloadId: string | undefined;
  let historyId: number | undefined;
  if (historyReachable && Array.isArray(history.data?.records)) {
    const grabbed = history.data.records.find((r: any) => {
      const type = String(r.eventType ?? "").toLowerCase();
      if (type !== "grabbed" && type !== "1") return false;
      const data = r.data ?? {};
      return data.guid === guid || data.Guid === guid || data.downloadUrl === guid;
    });
    if (grabbed) {
      historyId = typeof grabbed.id === "number" ? grabbed.id : undefined;
      downloadId = grabbed.downloadId ? String(grabbed.downloadId) : undefined;
    }
  }

  if (queueReachable && Array.isArray(queue.data?.records)) {
    const entityKey = service === "sonarr" ? "seriesId" : "movieId";
    const inQueue = queue.data.records.find((r: any) => {
      if (downloadId && r.downloadId && String(r.downloadId).toLowerCase() === downloadId.toLowerCase()) return true;
      if (!downloadId && releaseTitle && entityId !== undefined) {
        return r.title === releaseTitle && r[entityKey] === entityId;
      }
      return false;
    });
    if (inQueue) {
      return {
        found: true,
        serviceReachable: true,
        status: "downloading",
        downloadId: inQueue.downloadId ? String(inQueue.downloadId) : downloadId,
        queueId: typeof inQueue.id === "number" ? inQueue.id : undefined,
        historyId,
      };
    }
  }

  if (historyId !== undefined) {
    return { found: true, serviceReachable: true, status: "submitted", downloadId, historyId };
  }

  return { found: false, serviceReachable: historyReachable || queueReachable };
}

function isDefiniteRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^(Sonarr|Radarr) 4\d\d/.test(msg);
}

export function registerStepHandlers(executor: OperationExecutor): void {
  // ── P04: quarantine ──────────────────────────────────────────────────────
  executor.registerStepHandler("quarantine.move", async (_step, ctx) => {
    const target = ctx.target;
    if (!target) throw new Error("quarantine.move step has no target");
    const res = await quarantineFile(target.rootId, target.relativePath, {
      planId: ctx.plan.plan.id,
      expectedIdentity: target.fileIdentity,
    });
    return {
      entryPath: res.entryPath,
      originalRelativePath: res.originalRelativePath,
      sizeBytes: res.sizeBytes,
      nlink: res.nlink,
      reclaimableBytes: 0,
      reclaimableOnPurgeBytes: res.reclaimableOnPurgeBytes,
      expiresAt: res.expiresAt,
    };
  });

  executor.registerStepHandler("quarantine.remove_empty_dir", async (_step, ctx) => {
    const target = ctx.target;
    if (!target) throw new Error("quarantine.remove_empty_dir step has no target");
    const res = await removeEmptyDirectory(target.rootId, target.relativePath);
    return { removed: res.removed, reason: res.reason };
  });

  executor.registerStepHandler("quarantine.restore", async (_step, ctx) => {
    const target = ctx.target;
    if (!target) throw new Error("quarantine.restore step has no target");
    const res = await restoreQuarantined(target.rootId, target.relativePath);
    return { restoredRelativePath: res.restoredRelativePath };
  });

  executor.registerStepHandler("quarantine.purge", async (_step, ctx) => {
    const target = ctx.target;
    if (!target) throw new Error("quarantine.purge step has no target");
    const res = await purgeQuarantined(target.rootId, target.relativePath);
    return { freedBytes: res.freedBytes };
  });

  // ── P05: media format jobs ──────────────────────────────────────────────
  for (const action of ["remux", "transcode", "subtitle-convert"] as MediaAction[]) {
    executor.registerStepHandler(`media.${action}`, async (_step, ctx) => {
      const target = ctx.target;
      const effect = ctx.effect;
      if (!target || !effect) throw new Error(`media.${action} step has no target`);
      const profile = resolveProfile(action, effect.tracksProfile);
      const res = await executeMediaJob(
        { rootId: target.rootId, relativePath: target.relativePath, expectedIdentity: target.fileIdentity },
        profile,
        { planId: ctx.plan.plan.id, signal: ctx.signal }
      );
      return { ...res };
    });
  }

  // ── P07: downloads ──────────────────────────────────────────────────────
  executor.registerStepHandler("download.grab", async (_step, ctx) => {
    const effect = ctx.effect;
    if (!effect) throw new Error("download.grab step has no effect");
    const params = effect.params;
    const service = paramString(params, "service") as DownloadService | undefined;
    const guid = paramString(params, "guid");
    const indexerId = paramNumber(params, "indexerId");
    const entityId = paramNumber(params, "entityId");
    const releaseTitle = paramString(params, "releaseTitle");
    if (!service || !guid) throw new Error("download.grab requires service and guid params");

    const api = serviceApi(service);
    let postError: unknown;
    try {
      await api("release", "POST", { guid, indexerId }, GRAB_TIMEOUT_MS);
    } catch (err) {
      postError = err;
    }

    if (postError && isDefiniteRejection(postError)) {
      throw new Error(`${service} rejected the release: ${(postError as Error).message}`);
    }

    // Reconcile by identity whether the POST succeeded or timed out (CAT-06).
    let reconciled: GrabReconciliation = { found: false, serviceReachable: false };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (ctx.signal.aborted) break;
      reconciled = await reconcileGrab(service, guid, entityId, releaseTitle);
      if (reconciled.found) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (reconciled.found) {
      return {
        status: reconciled.status ?? "submitted",
        service,
        guid,
        indexerId,
        downloadId: reconciled.downloadId,
        queueId: reconciled.queueId,
        historyId: reconciled.historyId,
        reconciled: Boolean(postError),
      };
    }

    if (postError) {
      throw new UnknownOutcomeError(
        `Grab did not complete (${(postError as Error).message}) and the release could not be found in ${service}; not re-submitting`,
        { service, guid, serviceReachable: reconciled.serviceReachable }
      );
    }

    // The service accepted the request but has not surfaced it yet.
    return { status: "submitted", service, guid, indexerId, reconciled: false, note: "Accepted; not yet visible in history/queue" };
  });

  executor.registerStepHandler("download.cancel_previous", async (_step, ctx) => {
    const effect = ctx.effect;
    if (!effect) throw new Error("download.cancel_previous step has no effect");
    const service = paramString(effect.params, "service") as DownloadService | undefined;
    const ids = (paramString(effect.params, "queueIds") ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!service || ids.length === 0) throw new Error("download.cancel_previous requires service and queueIds params");
    await serviceApi(service)("queue/bulk?removeFromClient=true&blocklist=false", "DELETE", { ids } as any);
    return { cancelled: ids, service };
  });

  // ── Verifiers ───────────────────────────────────────────────────────────
  executor.registerVerifier("quarantine_files", async (record, results) => verifyQuarantine(record, results));
  executor.registerVerifier("quarantine_restore", async (record) => verifyRestore(record));
  executor.registerVerifier("quarantine_purge", async (record) => verifyPurge(record));
  executor.registerVerifier("media_format_conversion", async (record, results) => verifyMediaConversion(record, results));
  executor.registerVerifier("media_download", async (record, results) => verifyDownload(record, results));
  executor.registerVerifier("media_download_replacement", async (record, results) => verifyDownload(record, results));
}

async function verifyQuarantine(record: OperationPlanRecord, results: Array<Record<string, unknown> | undefined>): Promise<VerificationResult> {
  const problems: string[] = [];
  record.plan.effects.forEach((effect, i) => {
    if (effect.serviceAction !== "quarantine.move") return;
    const target = effect.targetIndex !== undefined ? record.plan.targets[effect.targetIndex] : undefined;
    const details = results[i];
    if (!target || !details?.entryPath) problems.push(`effect ${i + 1}: no quarantine entry recorded`);
  });
  if (problems.length) return { ok: false, reason: problems.join("; ") };

  for (let i = 0; i < record.plan.effects.length; i++) {
    const effect = record.plan.effects[i];
    if (effect.serviceAction !== "quarantine.move") continue;
    const target = record.plan.targets[effect.targetIndex!];
    const entryPath = String(results[i]!.entryPath);
    const original = await defaultRootFs.resolveWithinRoot(target.rootId, target.relativePath);
    if (original.exists) problems.push(`${target.relativePath} still present at its original path`);
    const entry = await defaultRootFs.resolveWithinRoot(target.rootId, `${QUARANTINE_DIR_NAME}/${entryPath}`);
    if (!entry.exists) problems.push(`quarantine entry ${entryPath} missing`);
  }
  return problems.length ? { ok: false, reason: problems.join("; ") } : { ok: true, reason: "Originals absent and quarantine entries present" };
}

async function verifyRestore(record: OperationPlanRecord): Promise<VerificationResult> {
  const problems: string[] = [];
  for (const effect of record.plan.effects) {
    if (effect.serviceAction !== "quarantine.restore") continue;
    const target = record.plan.targets[effect.targetIndex!];
    const entry = await defaultRootFs.resolveWithinRoot(target.rootId, `${QUARANTINE_DIR_NAME}/${target.relativePath}`);
    if (entry.exists) problems.push(`quarantine entry ${target.relativePath} still present`);
  }
  return problems.length ? { ok: false, reason: problems.join("; ") } : { ok: true };
}

async function verifyPurge(record: OperationPlanRecord): Promise<VerificationResult> {
  const problems: string[] = [];
  for (const effect of record.plan.effects) {
    if (effect.serviceAction !== "quarantine.purge") continue;
    const target = record.plan.targets[effect.targetIndex!];
    const entry = await defaultRootFs.resolveWithinRoot(target.rootId, `${QUARANTINE_DIR_NAME}/${target.relativePath}`);
    if (entry.exists) problems.push(`quarantine entry ${target.relativePath} still present`);
  }
  return problems.length ? { ok: false, reason: problems.join("; ") } : { ok: true };
}

async function verifyMediaConversion(record: OperationPlanRecord, results: Array<Record<string, unknown> | undefined>): Promise<VerificationResult> {
  const problems: string[] = [];
  for (let i = 0; i < record.plan.effects.length; i++) {
    const effect = record.plan.effects[i];
    if (!effect.serviceAction.startsWith("media.")) continue;
    const target = record.plan.targets[effect.targetIndex!];
    const details = results[i];
    const outputRelativePath = details?.outputRelativePath ? String(details.outputRelativePath) : undefined;
    const backupEntryPath = details?.backupEntryPath ? String(details.backupEntryPath) : undefined;
    if (!outputRelativePath || !backupEntryPath) {
      problems.push(`effect ${i + 1}: no output/backup recorded`);
      continue;
    }
    const output = await defaultRootFs.resolveWithinRoot(target.rootId, outputRelativePath);
    if (!output.exists || output.kind !== "file") problems.push(`output ${outputRelativePath} missing`);
    const backup = await defaultRootFs.resolveWithinRoot(target.rootId, `${QUARANTINE_DIR_NAME}/${backupEntryPath}`);
    if (!backup.exists) problems.push(`backup ${backupEntryPath} missing`);
  }
  return problems.length ? { ok: false, reason: problems.join("; ") } : { ok: true, reason: "Output published and original kept in quarantine" };
}

async function verifyDownload(record: OperationPlanRecord, results: Array<Record<string, unknown> | undefined>): Promise<VerificationResult> {
  const grabIndex = record.plan.effects.findIndex((e) => e.serviceAction === "download.grab");
  const details = grabIndex >= 0 ? results[grabIndex] : undefined;
  const status = details?.status ? String(details.status) : undefined;
  if (status !== "submitted" && status !== "downloading") {
    return { ok: false, reason: `grab status is ${status ?? "unknown"}`, partial: false };
  }
  return { ok: true, reason: `Release ${status}${details?.downloadId ? ` (download id ${details.downloadId})` : ""}` };
}
