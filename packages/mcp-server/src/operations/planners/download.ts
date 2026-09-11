import type { OperationPlan, PlannedTarget, PlannedEffect } from "@mediabox/contracts";
import { buildOperationPlan } from "../planner.js";
import { verifyReleaseRef, verifyMediaRef } from "../../queries/references.js";
import type { PlanScope } from "../../security/context.js";

export type DownloadService = "sonarr" | "radarr";

export type DownloadPlannerErrorCode =
  | "ERR_DUPLICATE_DOWNLOAD"
  | "ERR_INVALID_REFERENCE"
  | "ERR_NOTHING_TO_REPLACE"
  | "ERR_UNKNOWN_SERVICE";

export class DownloadPlannerError extends Error {
  constructor(message: string, public readonly code: DownloadPlannerErrorCode) {
    super(message);
    this.name = "DownloadPlannerError";
  }
}

/** Snapshot of an active download used to detect duplicates and to identify what a replacement cancels. */
export interface ActiveDownload {
  service: DownloadService;
  queueId: number;
  /** Download client id (torrent hash / nzb id) when known. */
  downloadId?: string;
  title?: string;
  /** Sonarr seriesId / Radarr movieId the queue item belongs to. */
  entityId?: number;
  guid?: string;
}

export interface CreateDownloadPlanInput {
  releaseRef: string;
  mediaRef?: string;
  replacement?: boolean;
  scope: PlanScope;
  /** Active queue observed fresh at proposal time (CAT-05). */
  activeQueue?: ActiveDownload[];
  ttlMs?: number;
}

export interface DownloadPlanSummary {
  service: DownloadService;
  releaseTitle: string;
  guid: string;
  indexerId?: number;
  mediaTitle: string;
  replacement: boolean;
  cancels: number[];
}

function inferService(payload: { serviceEntityIds?: Record<string, unknown>; mediaId?: string; id: string }): DownloadService {
  const declared = payload.serviceEntityIds?.service;
  if (declared === "sonarr" || declared === "radarr") return declared;
  const mediaId = payload.mediaId ?? "";
  if (mediaId.startsWith("series:")) return "sonarr";
  if (mediaId.startsWith("movie:")) return "radarr";
  throw new DownloadPlannerError(`Cannot determine download service for release ${payload.id}`, "ERR_UNKNOWN_SERVICE");
}

/**
 * Creates a persistent declarative OperationPlan for grabbing a release (P07 / CAT-05).
 * The grab is executed by the operations executor only after owner approval.
 */
export function createDownloadPlan(input: CreateDownloadPlanInput): { plan: OperationPlan; summary: DownloadPlanSummary } {
  const { scope } = input;
  const releasePayload = verifyReleaseRef(input.releaseRef, {
    installationId: scope.installationId,
    ownerId: scope.ownerId,
  });

  const service = inferService(releasePayload);
  const indexerIdRaw = releasePayload.serviceEntityIds?.indexerId;
  const indexerId = typeof indexerIdRaw === "number" ? indexerIdRaw : undefined;
  const entityIdRaw = releasePayload.serviceEntityIds?.[service === "sonarr" ? "sonarrId" : "radarrId"];
  const entityId = typeof entityIdRaw === "number" ? entityIdRaw : undefined;
  const releaseTitle = releasePayload.title || releasePayload.id;

  let mediaTitle = releaseTitle;
  let mediaId = releasePayload.mediaId || releasePayload.id;
  if (input.mediaRef) {
    const mediaPayload = verifyMediaRef(input.mediaRef, { installationId: scope.installationId, ownerId: scope.ownerId });
    mediaTitle = mediaPayload.title || mediaTitle;
    mediaId = mediaPayload.id;
  }

  const activeQueue = input.activeQueue ?? [];
  const sameEntity = activeQueue.filter((q) => q.service === service && (entityId === undefined || q.entityId === undefined || q.entityId === entityId));

  // Duplicate detection by stable identity: release guid first, exact title second (CAT-05).
  const duplicate = activeQueue.find(
    (q) => q.service === service && ((q.guid && q.guid === releasePayload.id) || (q.title && q.title === releaseTitle))
  );
  if (duplicate) {
    throw new DownloadPlannerError(
      `Release "${releaseTitle}" is already in the ${service} queue (queue id ${duplicate.queueId})`,
      "ERR_DUPLICATE_DOWNLOAD"
    );
  }

  const isReplacement = Boolean(input.replacement);
  const cancels = isReplacement ? sameEntity.map((q) => q.queueId) : [];
  if (isReplacement && cancels.length === 0) {
    throw new DownloadPlannerError(
      "Replacement requested but no active download for this media was found; propose a normal download instead",
      "ERR_NOTHING_TO_REPLACE"
    );
  }

  const targets: PlannedTarget[] = [
    {
      service,
      entityId: entityId !== undefined ? String(entityId) : mediaId,
      rootId: "downloads",
      relativePath: releaseTitle,
      observedState: "proposed_download",
    },
  ];

  const grabParams: Record<string, string | number | boolean> = {
    service,
    guid: releasePayload.id,
    mediaId,
    releaseTitle,
  };
  if (indexerId !== undefined) grabParams.indexerId = indexerId;
  if (entityId !== undefined) grabParams.entityId = entityId;

  const effects: PlannedEffect[] = [
    {
      targetIndex: 0,
      serviceAction: "download.grab",
      irreversibleLoss: false,
      params: grabParams,
    },
  ];

  if (isReplacement) {
    // The new download is secured first; the previous one is cancelled only afterwards and only
    // because the owner explicitly approved a replacement plan (never implicitly, CAT-05).
    effects.push({
      targetIndex: 0,
      serviceAction: "download.cancel_previous",
      irreversibleLoss: true,
      params: { service, queueIds: cancels.join(",") },
    });
  }

  const plan = buildOperationPlan({
    installationId: scope.installationId,
    ownerId: scope.ownerId,
    conversationId: scope.conversationId,
    operation: isReplacement ? "media_download_replacement" : "media_download",
    targets,
    effects,
    preconditions: [
      {
        id: "prec_release_guid",
        type: "custom",
        description: `Release GUID ${releasePayload.id} verified against a signed releaseRef`,
        expected: releasePayload.id,
        actual: releasePayload.id,
      },
    ],
    recovery: {
      strategy: "rollback_service",
      instructions: "If the grab is uncertain the plan ends in unknown_outcome; reconcile the queue by release guid before proposing again.",
    },
    ttlMs: input.ttlMs ?? 10 * 60 * 1000,
  });

  return {
    plan,
    summary: { service, releaseTitle, guid: releasePayload.id, indexerId, mediaTitle, replacement: isReplacement, cancels },
  };
}
