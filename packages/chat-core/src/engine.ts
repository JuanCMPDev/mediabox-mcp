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
import type { StreamChatOptions, ChatMessage, ToolCallInfo, ToolResultInfo } from './types.js';
import type { LLMStreamChunk } from './providers/types.js';
import { selectTools }      from './tool-selector.js';
import { executeVirtualTool } from './tool-router.js';
import { trimHistory }      from './history.js';
import { buildSystemPrompt } from './prompt.js';

const MAX_ITERATIONS = 20;
const TOOL_TIMEOUT_MS = 60_000;

/** Localised fallback strings for responses produced by the engine itself
 *  (not by the LLM). Kept tiny so we don't grow another full i18n bundle. */
interface EngineFallbacks {
  empty:     string;
  iterLimit: string;
}

const FALLBACKS: Record<'en' | 'es', EngineFallbacks> = {
  en: { empty: '(no response)',  iterLimit: 'Iteration limit reached. Start a new conversation.' },
  es: { empty: '(sin respuesta)', iterLimit: 'Límite de iteraciones alcanzado. Inicia una nueva conversación.' },
};

function pickFallback(locale: string | undefined): EngineFallbacks {
  return locale === 'es' ? FALLBACKS.es : FALLBACKS.en;
}

export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatEvent> {
  const { message, conversationId, provider, mcpCall, historyStore, locale } = opts;
  const fallbacks   = pickFallback(locale);
  const systemPrompt = buildSystemPrompt(locale);

  yield { type: 'conversation', id: conversationId };

  const history = historyStore.get(conversationId);
  history.push({ role: 'user', content: message });
  historyStore.set(conversationId, history);

  const selectedTools = selectTools(message);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let accText = '';
    const accCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

    const llmStream = provider.stream({
      systemPrompt,
      messages:     history,
      tools:        selectedTools,
    }) as AsyncGenerator<LLMStreamChunk>;

    for await (const chunk of llmStream) {
      if (chunk.type === 'text') {
        accText += chunk.text;
        yield { type: 'token', text: chunk.text };
      } else if (chunk.type === 'tool_call') {
        accCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
      }
      // chunk.type === 'done' → loop continues naturally
    }

    if (accCalls.length > 0) {
      // Save assistant turn with tool call intentions
      const tcs: ToolCallInfo[] = accCalls.map(c => ({ id: c.id, name: c.name, args: c.args }));
      history.push({ role: 'assistant', content: accText, toolCalls: tcs });

      // Execute each tool and emit progress events
      const results: ToolResultInfo[] = [];
      for (const tc of accCalls) {
        yield { type: 'tool-start', name: tc.name, args: tc.args };
        const t0 = Date.now();
        let result: string;
        try {
          result = await raceTimeout(
            executeVirtualTool(tc.name, tc.args, mcpCall),
            TOOL_TIMEOUT_MS,
            `Tool ${tc.name} timed out`,
          );
        } catch (err) {
          result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
        const ok = !result.includes('"error"');
        yield { type: 'tool-end', name: tc.name, ok, durationMs: Date.now() - t0 };
        results.push({ id: tc.id, name: tc.name, result });
      }

      // Save tool results as a user-role message (both OpenAI and Gemini expect this)
      history.push({ role: 'user', content: '', toolResults: results });
      historyStore.set(conversationId, trimHistory(history));
      continue; // next iteration: feed results back to LLM
    }

    // No tool calls — this is the final natural-language response
    const finalText = accText || fallbacks.empty;
    history.push({ role: 'assistant', content: finalText });
    historyStore.set(conversationId, trimHistory(history));
    yield { type: 'done', fullText: finalText };
    return;
  }

  yield { type: 'error', message: fallbacks.iterLimit };
}

function raceTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, r) => setTimeout(() => r(new Error(msg)), ms)),
  ]);
}

/**
 * Non-streaming wrapper around streamChat(): consumes the event stream and
 * returns the final natural-language response as a single string.
 * For clients that can't render progressive output (e.g. Telegram bot).
 */
export async function runChat(opts: StreamChatOptions): Promise<string> {
  const fallbacks = pickFallback(opts.locale);
  let accumulated = '';
  for await (const evt of streamChat(opts)) {
    if (evt.type === 'token') accumulated += evt.text;
    if (evt.type === 'done')  return evt.fullText;
    if (evt.type === 'error') return `⚠ ${evt.message}`;
  }
  return accumulated || fallbacks.empty;
}
