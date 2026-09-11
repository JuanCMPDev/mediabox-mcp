/* ─── Streaming chat engine ──────────────────────────────────────────────────
 * Orchestrates the LLM ↔ MCP tool-calling loop and yields ChatEvent objects
 * as NDJSON events to the caller (mcp-server SSE endpoint → browser).
 *
 * Flow per turn:
 *   1. Append user message to history
 *   2. Select tools relevant to the message
 *   3. Stream from LLM provider
 *   4. If tool_call chunks arrive → execute tools, append result, loop
 *   5. If only text → yield tokens, emit 'done', return
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatEvent } from '@mediabox/contracts';
import type { StreamChatOptions } from './types.js';
import { AgentRuntime } from './agent/runtime.js';

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatEvent> {
  yield* AgentRuntime.streamTurn(opts);
}

/**
 * Non-streaming wrapper around streamChat(): consumes the event stream and
 * returns the final natural-language response as a single string.
 * For clients that can't render progressive output (e.g. Telegram bot).
 */
export async function runChat(opts: StreamChatOptions): Promise<string> {
  let accumulated = '';
  for await (const evt of streamChat(opts)) {
    if (evt.type === 'token') accumulated += evt.text;
    if (evt.type === 'done')  return evt.fullText;
    if (evt.type === 'guard') return `⚠ ${evt.message}`;
    if (evt.type === 'error') return `⚠ ${evt.message}`;
  }
  return accumulated || (opts.locale === 'es' ? '(sin respuesta)' : '(no response)');
}

