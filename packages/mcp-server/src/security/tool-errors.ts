import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createErrorEnvelope, envelopeToolResult } from "../queries/envelope.js";
import { sanitizeString } from "../helpers/diagnostics-sanitizer.js";

/**
 * Errors thrown by a tool handler reach the agent as a sanitized error envelope
 * with a stable code (NET-05, AGT-06). Without this the MCP SDK returned the raw
 * message, which carries the upstream response body ("Jellyfin API 500: {...}")
 * and, for filesystem errors, host paths. An upstream failure keeps only the
 * service and its HTTP status; the body is never forwarded.
 */

const UPSTREAM = /^(Jellyfin API|Sonarr|Radarr|Prowlarr|qBittorrent|PyLoad|Bazarr)\s+(\d{3})\b/i;
const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "EAI_AGAIN"]);

export interface ToolErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
}

export function classifyToolError(err: unknown): ToolErrorInfo {
  const e = (err ?? {}) as { code?: unknown; name?: unknown; cause?: { code?: unknown } };
  const message = err instanceof Error ? err.message : String(err);

  const upstream = message.match(UPSTREAM);
  if (upstream) {
    const service = upstream[1].replace(/\s+API$/i, "");
    const status = Number(upstream[2]);
    const unavailable = status >= 500 || status === 408 || status === 429;
    return {
      code: unavailable ? "ERR_UPSTREAM_UNAVAILABLE" : "ERR_UPSTREAM_REJECTED",
      message: `${service} answered HTTP ${status}${unavailable ? " and is unavailable" : ""}; its response body is withheld.`,
      retryable: unavailable,
    };
  }
  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return { code: "ERR_UPSTREAM_TIMEOUT", message: "A service did not answer in time.", retryable: true };
  }
  const cause = typeof e.cause?.code === "string" ? e.cause.code : undefined;
  if ((cause && UNREACHABLE.has(cause)) || message === "fetch failed") {
    return { code: "ERR_UPSTREAM_UNAVAILABLE", message: "A service could not be reached.", retryable: true };
  }
  if (e.code === "ENOENT") return { code: "ERR_PATH_NOT_FOUND", message: "The path does not exist.", retryable: false };
  if (e.code === "EACCES" || e.code === "EPERM") return { code: "ERR_PATH_DENIED", message: "The path cannot be accessed.", retryable: false };

  const code = typeof e.code === "string" && /^ERR_[A-Z0-9_]+$/.test(e.code) ? e.code : "ERR_TOOL_FAILED";
  return { code, message: sanitizeString(message.split("\n")[0]).slice(0, 200), retryable: false };
}

export function toolErrorResult(err: unknown) {
  return envelopeToolResult(createErrorEnvelope(classifyToolError(err)));
}

/**
 * Wraps every handler registered on `server` so a thrown error becomes an error
 * envelope. Must run before the tools are registered and after
 * instrumentToolAudit, so the audit records the envelope's code.
 */
export function instrumentToolErrors(server: McpServer): void {
  const target = server as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["tool", "registerTool"] as const) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function (this: unknown, ...regArgs: unknown[]) {
      const handler = regArgs[regArgs.length - 1];
      if (typeof handler === "function") {
        regArgs[regArgs.length - 1] = async (...callArgs: unknown[]) => {
          try {
            return await (handler as (...a: unknown[]) => unknown)(...callArgs);
          } catch (err) {
            // Protocol errors (e.g. URL elicitation) are the SDK's to deliver.
            if (err instanceof McpError) throw err;
            return toolErrorResult(err);
          }
        };
      }
      return original.apply(this ?? server, regArgs);
    };
  }
}
