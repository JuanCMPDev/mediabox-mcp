/* ─── Cached MCP caller factory ──────────────────────────────────────────────
 * Wraps a connected @modelcontextprotocol/sdk Client with:
 *  - 60 s timeout per tool call
 *  - TTL-based read cache (same TTL map as the Telegram bot)
 *  - Write-invalidation: any write tool clears the entire cache
 * ──────────────────────────────────────────────────────────────────────── */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpCallFn } from './types.js';

const TOOL_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARS = 30_000;

const CACHE_TTL: Record<string, number> = {
  server_status:  60_000,
  search_media:   30_000,
  show_details:  300_000,
  series_status:  30_000,
  movie_status:   30_000,
};

const ALWAYS_WRITE = new Set([
  'series_grab', 'movie_grab', 'manage_files', 'manage_library',
  'series_remove', 'movie_remove', 'optimize_media', 'fix_subtitles',
  'cleanup_server', 'download_add', 'download_direct', 'cancel_downloads',
  'rename_episodes',
]);

function isWriteCall(name: string, args: Record<string, unknown>): boolean {
  if (ALWAYS_WRITE.has(name)) return true;
  if (name === 'series_search' && args.addTvdbId) return true;
  if (name === 'movie_search'  && args.addTmdbId) return true;
  return false;
}

async function callWithTimeout(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const resultProm = client.callTool({ name, arguments: args });
  const timeoutProm = new Promise<never>((_, r) =>
    setTimeout(() => r(new Error(`Tool ${name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
  );
  const result = await Promise.race([resultProm, timeoutProm]);
  const content = result.content as Array<{ type: string; text?: string }>;
  let text = content.filter(c => c.type === 'text' && c.text).map(c => c.text!).join('\n');
  if (text.length > MAX_RESULT_CHARS) text = text.slice(0, MAX_RESULT_CHARS) + '\n...(truncated)';
  return text;
}

/** Returns a McpCallFn backed by the given client with caching + timeout. */
export function createMcpCaller(client: Client): McpCallFn {
  const cache = new Map<string, { data: string; expires: number }>();

  return async function callMCP(name: string, args: Record<string, unknown>): Promise<string> {
    // Strip null/undefined keys (cleaner JSON for the LLM)
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null) clean[k] = v;
    }

    if (isWriteCall(name, clean)) {
      cache.clear();
      return callWithTimeout(client, name, clean);
    }

    const ttl = CACHE_TTL[name];
    if (ttl) {
      const key = `${name}:${JSON.stringify(clean)}`;
      const hit = cache.get(key);
      if (hit && Date.now() < hit.expires) return hit.data;
      const result = await callWithTimeout(client, name, clean);
      cache.set(key, { data: result, expires: Date.now() + ttl });
      return result;
    }

    return callWithTimeout(client, name, clean);
  };
}
