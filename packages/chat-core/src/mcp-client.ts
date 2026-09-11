/* ─── Cached MCP caller factory ──────────────────────────────────────────────
 * Wraps a connected @modelcontextprotocol/sdk Client with:
 *  - 150 s timeout per tool call
 *  - TTL-based read cache (successful reads only)
 *  - Proposal tools (propose_*) and operation_status are never cached.
 *    Proposals clear the read cache; an operation_status that reports a plan
 *    as succeeded/partial clears it too, so post-approval verification reads
 *    are fresh.
 *  - Result budgeting: tool text is bounded to valid JSON / safely cut text
 *    (result-budget.ts) instead of a blind character slice.
 *  - MCP `isError` results surface as {"isError":true,"error":"..."} so the
 *    engine can detect failures structurally.
 * ──────────────────────────────────────────────────────────────────────── */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpCallFn } from './types.js';
import { boundToolResultText, detectToolFailure } from './result-budget.js';

const TOOL_TIMEOUT_MS = 150_000;

/** Read-cache TTLs in ms. 0 / absent = never cached. */
const CACHE_TTL: Record<string, number> = {
  server_status:    60_000,
  jellyfin_search:  30_000,
  search_media:     30_000,
  show_details:    300_000,
  series_status:    30_000,
  movie_status:     30_000,
  media_details:    60_000,
  find_releases:         0,
};

/** Proposal tools: never cached, and they invalidate the read cache. */
const PROPOSAL_TOOLS = new Set(['propose_download', 'propose_cleanup', 'propose_media_job']);

/** Never served from cache. */
const ALWAYS_WRITE = new Set([...PROPOSAL_TOOLS, 'operation_status']);

function isWriteCall(name: string): boolean {
  return ALWAYS_WRITE.has(name);
}

/** A plan that finished changing the library makes every cached read stale. */
function planChangedLibrary(name: string, text: string): boolean {
  if (name !== 'operation_status') return false;
  try {
    const parsed = JSON.parse(text) as { status?: unknown } | null;
    return !!parsed && typeof parsed === 'object' && (parsed.status === 'succeeded' || parsed.status === 'partial');
  } catch {
    return false;
  }
}

interface ToolCallResultLike {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

/** Flatten an MCP tool result into bounded text for the LLM. */
function normalizeResult(name: string, result: ToolCallResultLike): string {
  const content = Array.isArray(result.content)
    ? (result.content as Array<{ type?: string; text?: unknown }>)
    : [];
  let text = content
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text as string)
    .join('\n');

  if (!text && result.structuredContent !== undefined) {
    try { text = JSON.stringify(result.structuredContent); } catch { /* unserializable — fall through */ }
  }

  if (result.isError === true) {
    return boundToolResultText(JSON.stringify({ isError: true, error: text || `Tool ${name} failed` }));
  }
  return boundToolResultText(text);
}

async function callWithTimeout(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutProm = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool ${name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`)),
      TOOL_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([client.callTool({ name, arguments: args }), timeoutProm]);
    return normalizeResult(name, result as unknown as ToolCallResultLike);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns a McpCallFn backed by the given client with caching + timeout. */
export function createMcpCaller(client: Client): McpCallFn {
  const cache = new Map<string, { data: string; expires: number }>();

  return async function callMCP(name: string, args: Record<string, unknown>): Promise<string> {
    // Strip null/undefined keys (cleaner JSON for the server's zod schemas)
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (v !== undefined && v !== null) clean[k] = v;
    }

    if (isWriteCall(name)) {
      if (PROPOSAL_TOOLS.has(name)) cache.clear();
      const text = await callWithTimeout(client, name, clean);
      if (planChangedLibrary(name, text)) cache.clear();
      return text;
    }

    const ttl = CACHE_TTL[name] ?? 0;
    if (ttl > 0) {
      const key = `${name}:${JSON.stringify(clean)}`;
      const hit = cache.get(key);
      if (hit && Date.now() < hit.expires) return hit.data;
      const result = await callWithTimeout(client, name, clean);
      if (!detectToolFailure(result)) cache.set(key, { data: result, expires: Date.now() + ttl });
      return result;
    }

    return callWithTimeout(client, name, clean);
  };
}
