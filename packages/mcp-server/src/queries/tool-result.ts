import type { ToolEnvelope } from "@mediabox/contracts";
import { createErrorEnvelope, envelopeToolResult, type EnvelopeToolResult } from "./envelope.js";
import { CursorValidationError } from "./pagination.js";
import { ReferenceValidationError } from "./references.js";
import { BudgetExhaustedError } from "./budgets.js";
import { RootFsError } from "../storage/rootfs.js";
import { PathMappingUnknownError } from "../storage/namespace-map.js";
import { QuarantineError } from "../storage/quarantine.js";
import { MediaJobError } from "../storage/media-jobs.js";
import { OperationStoreError } from "../operations/store.js";
import { DeletePlannerError } from "../operations/planners/delete.js";
import { DownloadPlannerError } from "../operations/planners/download.js";
import { MutationContainedError } from "../helpers/containment.js";

const RETRYABLE_CODES = new Set(["ERR_EXPIRED_CURSOR", "ERR_UPSTREAM_UNAVAILABLE", "ERR_QUERY_TIMEOUT"]);

function sanitize(message: string): string {
  return message.replace(/(key|token|password|auth|apikey)=([^&\s]+)/gi, "$1=[REDACTED]").slice(0, 500);
}

/** Maps a thrown error to a sanitized error envelope with a stable code. */
export function toErrorEnvelope(err: unknown): ToolEnvelope<null> {
  const known =
    err instanceof CursorValidationError ||
    err instanceof ReferenceValidationError ||
    err instanceof BudgetExhaustedError ||
    err instanceof RootFsError ||
    err instanceof PathMappingUnknownError ||
    err instanceof QuarantineError ||
    err instanceof MediaJobError ||
    err instanceof OperationStoreError ||
    err instanceof DeletePlannerError ||
    err instanceof DownloadPlannerError ||
    err instanceof MutationContainedError;

  if (known) {
    const code = (err as { code: string }).code;
    return createErrorEnvelope({ code, message: sanitize((err as Error).message), retryable: RETRYABLE_CODES.has(code) });
  }
  const message = err instanceof Error ? err.message : String(err);
  return createErrorEnvelope({ code: "ERR_INTERNAL", message: sanitize(message) });
}

/** Runs a query/proposal tool body and always returns an envelope result (never throws). */
export async function runEnvelopeTool<T>(fn: () => Promise<ToolEnvelope<T>>): Promise<EnvelopeToolResult> {
  try {
    return envelopeToolResult(await fn());
  } catch (err) {
    return envelopeToolResult(toErrorEnvelope(err));
  }
}
