/* ─── Tool audit ledger ───────────────────────────────────────────────────────
 * Every executed MCP tool handler leaves one row: who called it, in which
 * conversation, with which arguments and how it ended. The row is written by
 * the server, so it does not depend on what the model says it did (P11 §4.3).
 * Schema-invalid calls never reach a handler and are therefore not "executed".
 * ──────────────────────────────────────────────────────────────────────── */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAuditRecord } from "@mediabox/contracts";
import type { DatabaseAdapter } from "../operations/sqlite/contract.js";
import { defaultDatabaseAdapter } from "../operations/default-store.js";
import type { McpToolContext } from "./context.js";

const MAX_ARGS_CHARS = 4096;
const MAX_ROWS = 50_000;
const PRUNE_EVERY = 500;

interface AuditRow {
  id: number;
  ts: string;
  principal_id: string;
  principal_kind: string;
  session_id: string;
  conversation_id: string;
  tool: string;
  args_json: string;
  ok: number;
  error_code: string | null;
  duration_ms: number;
}

export class ToolAuditLog {
  private inserts = 0;

  constructor(private readonly db: DatabaseAdapter) {}

  record(entry: Omit<ToolAuditRecord, "id">): void {
    this.db
      .prepare(
        `INSERT INTO tool_audit (ts, principal_id, principal_kind, session_id, conversation_id, tool, args_json, ok, error_code, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ts,
        entry.principalId,
        entry.principalKind,
        entry.sessionId,
        entry.conversationId,
        entry.tool,
        entry.argsJson,
        entry.ok ? 1 : 0,
        entry.errorCode ?? null,
        entry.durationMs,
      );
    if (++this.inserts % PRUNE_EVERY === 0) {
      this.db
        .prepare("DELETE FROM tool_audit WHERE id <= (SELECT MAX(id) FROM tool_audit) - ?")
        .run(MAX_ROWS);
    }
  }

  list(opts: { sinceId?: number; limit?: number } = {}): ToolAuditRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const rows = this.db
      .prepare("SELECT * FROM tool_audit WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all<AuditRow>(opts.sinceId ?? 0, limit);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      principalId: r.principal_id,
      principalKind: r.principal_kind,
      sessionId: r.session_id,
      conversationId: r.conversation_id,
      tool: r.tool,
      argsJson: r.args_json,
      ok: r.ok === 1,
      errorCode: r.error_code ?? undefined,
      durationMs: r.duration_ms,
    }));
  }
}

export const defaultToolAuditLog = new ToolAuditLog(defaultDatabaseAdapter);

function boundedJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? {});
  } catch {
    text = '"[unserializable]"';
  }
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…[truncated]` : text;
}

function errorCodeOf(result: unknown): string | undefined {
  const r = result as { isError?: boolean; structuredContent?: any; content?: Array<{ type: string; text?: string }> };
  if (!r?.isError) return undefined;
  const sc = r.structuredContent;
  const code = sc?.error?.code ?? sc?.code;
  if (typeof code === "string") return code;
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  const match = text.match(/\b(ERR_[A-Z0-9_]+|OPERATION_[A-Z0-9_]+)\b/);
  return match?.[1] ?? "TOOL_ERROR";
}

/**
 * Wraps every handler registered on `server` so each execution is recorded.
 * Must run before the tools are registered. A failing audit write never
 * changes the tool result.
 */
export function instrumentToolAudit(server: McpServer, context: McpToolContext, log: ToolAuditLog | null): void {
  if (!log) return;
  const target = server as unknown as Record<string, (...args: unknown[]) => unknown>;

  for (const method of ["tool", "registerTool"] as const) {
    const original = target[method];
    if (typeof original !== "function") continue;
    target[method] = function (this: unknown, ...regArgs: unknown[]) {
      const name = String(regArgs[0]);
      const handler = regArgs[regArgs.length - 1];
      if (typeof handler === "function") {
        regArgs[regArgs.length - 1] = async (...callArgs: unknown[]) => {
          const started = Date.now();
          // Handlers with an input schema receive (args, extra); without one only (extra).
          const args = callArgs.length >= 2 ? callArgs[0] : {};
          const write = (ok: boolean, errorCode?: string) => {
            try {
              log.record({
                ts: new Date(started).toISOString(),
                principalId: context.principal.id,
                principalKind: context.principal.kind,
                sessionId: context.principal.sessionId,
                conversationId: context.conversationId,
                tool: name,
                argsJson: boundedJson(args),
                ok,
                errorCode,
                durationMs: Date.now() - started,
              });
            } catch (err) {
              console.error(`[tool-audit] could not record ${name}: ${(err as Error).message}`);
            }
          };
          try {
            const result = await (handler as (...a: unknown[]) => unknown)(...callArgs);
            const code = errorCodeOf(result);
            write(code === undefined, code);
            return result;
          } catch (err) {
            const e = err as { code?: unknown; name?: string };
            write(false, typeof e?.code === "string" ? e.code : e?.name ?? "TOOL_THROWN");
            throw err;
          }
        };
      }
      return original.apply(this ?? server, regArgs);
    };
  }
}
