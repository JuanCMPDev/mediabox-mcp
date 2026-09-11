import { randomUUID } from "node:crypto";
import type {
  ToolEnvelope,
  DataSourceStatus,
  EnvelopePage,
  EnvelopeBudget,
} from "@mediabox/contracts";

export const DEFAULT_ENVELOPE_BYTE_LIMIT = 8192; // 8 KiB default per Blueprint 4.4

export interface CreateEnvelopeOptions<T> {
  data: T;
  requestId?: string;
  sources?: DataSourceStatus[];
  page?: EnvelopePage;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  budget?: Partial<EnvelopeBudget>;
}

export function createToolEnvelope<T>(options: CreateEnvelopeOptions<T>): ToolEnvelope<T> {
  const requestId = options.requestId || `req_${randomUUID()}`;
  const sources = options.sources ?? [];
  const warnings = options.warnings;
  const error = options.error;

  let status: "ok" | "partial" | "error" = "ok";
  if (error) {
    status = "error";
  } else {
    const hasIncompleteSource = sources.some(
      (s) => s.completeness === "partial" || s.completeness === "unavailable"
    );
    if (hasIncompleteSource || (warnings && warnings.length > 0)) {
      status = "partial";
    }
  }

  const budget: EnvelopeBudget | undefined = options.budget
    ? {
        bytesUsed: options.budget.bytesUsed ?? 0,
        bytesLimit: options.budget.bytesLimit ?? DEFAULT_ENVELOPE_BYTE_LIMIT,
        itemsReturned: options.budget.itemsReturned ?? (Array.isArray(options.data) ? options.data.length : 1),
        itemsAvailable: options.budget.itemsAvailable,
        truncatedFields: options.budget.truncatedFields,
      }
    : undefined;

  return {
    schemaVersion: 1,
    requestId,
    status,
    data: options.data,
    sources,
    page: options.page,
    warnings,
    error,
    budget,
  };
}

export function createErrorEnvelope(opts: {
  code: string;
  message: string;
  requestId?: string;
  sources?: DataSourceStatus[];
  retryable?: boolean;
}): ToolEnvelope<null> {
  return createToolEnvelope<null>({
    requestId: opts.requestId,
    data: null,
    sources: opts.sources,
    error: {
      code: opts.code,
      message: opts.message,
      retryable: opts.retryable,
    },
  });
}

/**
 * Truncates a UTF-16 string safely without breaking surrogate pairs.
 */
export function safeSubstring(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  let cut = maxLength;
  const code = str.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    cut -= 1;
  }
  return str.slice(0, cut) + "...";
}

export interface BoundedEnvelope {
  envelope: ToolEnvelope<unknown>;
  json: string;
  bytes: number;
  truncated: boolean;
}

/**
 * Bounds an envelope to `maxBytes` without ever producing invalid JSON (QRY-02).
 * Long strings are shortened on safe boundaries and arrays are trimmed in
 * successive passes; every pruned field is listed in `budget.truncatedFields`.
 * The caller's envelope is never mutated.
 */
export function boundEnvelope<T>(envelope: ToolEnvelope<T>, maxBytes: number = DEFAULT_ENVELOPE_BYTE_LIMIT): BoundedEnvelope {
  const initialJson = JSON.stringify(envelope);
  const initialByteLength = Buffer.byteLength(initialJson, "utf8");

  if (initialByteLength <= maxBytes) {
    const withBudget: ToolEnvelope<T> = envelope.budget
      ? { ...envelope, budget: { ...envelope.budget, bytesUsed: initialByteLength, bytesLimit: maxBytes } }
      : envelope;
    const json = JSON.stringify(withBudget);
    return { envelope: withBudget, json, bytes: Buffer.byteLength(json, "utf8"), truncated: false };
  }

  const cloned: ToolEnvelope<any> = JSON.parse(initialJson);
  const truncatedFields: string[] = cloned.budget?.truncatedFields ? [...cloned.budget.truncatedFields] : [];

  function pruneObject(obj: any, path: string, maxStringLen: number, maxArrayLen: number): void {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      if (obj.length > maxArrayLen) {
        obj.splice(maxArrayLen);
        truncatedFields.push(`${path}[array_trimmed_to_${maxArrayLen}]`);
      }
      for (let i = 0; i < obj.length; i++) {
        const item = obj[i];
        if (typeof item === "string" && item.length > maxStringLen) {
          obj[i] = safeSubstring(item, maxStringLen);
          truncatedFields.push(`${path}[${i}]`);
        } else if (typeof item === "object" && item !== null) {
          pruneObject(item, `${path}[${i}]`, maxStringLen, maxArrayLen);
        }
      }
      return;
    }

    for (const key of Object.keys(obj)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const val = obj[key];
      if (typeof val === "string" && val.length > maxStringLen) {
        obj[key] = safeSubstring(val, maxStringLen);
        truncatedFields.push(fieldPath);
      } else if (typeof val === "object" && val !== null) {
        pruneObject(val, fieldPath, maxStringLen, maxArrayLen);
      }
    }
  }

  if (!cloned.budget) {
    cloned.budget = {
      bytesUsed: 0,
      bytesLimit: maxBytes,
      itemsReturned: Array.isArray(cloned.data) ? cloned.data.length : 1,
    };
  }

  const passes: Array<[number, number]> = [
    [100, 5],
    [30, 5],
    [15, 2],
  ];
  let serialized = "";
  let byteLen = Number.POSITIVE_INFINITY;
  for (const [maxStr, maxArr] of passes) {
    pruneObject(cloned.data, "data", maxStr, maxArr);
    if (Array.isArray(cloned.warnings) && cloned.warnings.length > maxArr) {
      cloned.warnings = cloned.warnings.slice(0, maxArr);
      truncatedFields.push("warnings[array_trimmed]");
    }
    cloned.budget.truncatedFields = [...new Set(truncatedFields)];
    serialized = JSON.stringify(cloned);
    byteLen = Buffer.byteLength(serialized, "utf8");
    if (byteLen <= maxBytes) break;
  }

  if (byteLen > maxBytes) {
    // Last resort: keep the envelope skeleton and drop the payload entirely.
    cloned.data = Array.isArray(cloned.data) ? [] : null;
    truncatedFields.push("data[dropped_over_budget]");
    cloned.budget.truncatedFields = [...new Set(truncatedFields)];
    serialized = JSON.stringify(cloned);
    byteLen = Buffer.byteLength(serialized, "utf8");
  }

  cloned.budget.bytesUsed = byteLen;
  cloned.budget.bytesLimit = maxBytes;
  const json = JSON.stringify(cloned);
  return { envelope: cloned, json, bytes: Buffer.byteLength(json, "utf8"), truncated: true };
}

/**
 * Safely serializes an envelope to JSON, ensuring valid output within `maxBytes`.
 */
export function safeSerializeEnvelope<T>(envelope: ToolEnvelope<T>, maxBytes: number = DEFAULT_ENVELOPE_BYTE_LIMIT): string {
  return boundEnvelope(envelope, maxBytes).json;
}

export interface EnvelopeToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * MCP tool result for an envelope (Blueprint 4.4): `structuredContent` carries the
 * bounded envelope, the text block is the same JSON for older clients, and
 * `isError` mirrors `status === "error"`.
 */
export function envelopeToolResult<T>(envelope: ToolEnvelope<T>, maxBytes: number = DEFAULT_ENVELOPE_BYTE_LIMIT): EnvelopeToolResult {
  const bounded = boundEnvelope(envelope, maxBytes);
  const result: EnvelopeToolResult = {
    content: [{ type: "text", text: bounded.json }],
    structuredContent: bounded.envelope as unknown as Record<string, unknown>,
  };
  if (envelope.status === "error") result.isError = true;
  return result;
}
