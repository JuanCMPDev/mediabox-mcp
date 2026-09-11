import OpenAI from 'openai';
import type { StreamProvider, LLMStreamChunk } from './types.js';
import type { ChatMessage, VirtualToolDef } from '../types.js';
import { buildOpenRouterMessages } from '../history.js';
import { INVALID_TOOL_ARGS_KEY } from './local.js';

function parseArgs(raw: string): Record<string, unknown> {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  return { [INVALID_TOOL_ARGS_KEY]: trimmed };
}

export class OpenRouterProvider implements StreamProvider {
  readonly providerName = 'openrouter' as const;
  readonly model: string;
  private client: OpenAI;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey });
    this.model  = model;
  }

  async *stream(opts: {
    systemPrompt: string;
    messages:     ChatMessage[];
    tools:        VirtualToolDef[];
    signal?:      AbortSignal;
    maxTokens?:   number;
  }): AsyncGenerator<LLMStreamChunk> {
    const { messages, tools } = buildOpenRouterMessages(opts.messages, opts.tools, opts.systemPrompt);

    const raw = await this.client.chat.completions.create(
      {
        model:       this.model,
        messages,
        tools:       tools.length ? tools : undefined,
        temperature: 0.3,
        stream:      true,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        stream_options: { include_usage: true },
      },
      // Cancelling the turn must close the HTTP stream, not just stop reading it (§2.9).
      opts.signal ? { signal: opts.signal } : undefined,
    );

    // Accumulate tool call fragments across chunks (OpenAI sends args in pieces)
    const tcBuffers = new Map<number, { id: string; name: string; argsJson: string }>();
    let emitted = false;

    for await (const chunk of raw) {
      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          },
        };
      }

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) yield { type: 'text', text: delta.content };

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index;
        if (!tcBuffers.has(idx)) tcBuffers.set(idx, { id: '', name: '', argsJson: '' });
        const buf = tcBuffers.get(idx)!;
        if (tc.id)                 buf.id       = tc.id;
        if (tc.function?.name)     buf.name     = tc.function.name;
        if (tc.function?.arguments) buf.argsJson += tc.function.arguments;
      }

      const finish = chunk.choices[0]?.finish_reason;
      if (finish === 'tool_calls' || (finish === 'length' && tcBuffers.size > 0)) {
        const entries = [...tcBuffers.entries()].sort((a, b) => a[0] - b[0]);
        tcBuffers.clear();
        for (const [idx, buf] of entries) {
          // Unparseable arguments must never become {}: the engine needs to see them
          // as invalid so its single repair applies (§2.5).
          const args = finish === 'length' ? { [INVALID_TOOL_ARGS_KEY]: buf.argsJson } : parseArgs(buf.argsJson);
          yield { type: 'tool_call', id: buf.id || `or_${idx}`, name: buf.name, args };
          emitted = true;
        }
      }
    }

    if (!emitted && tcBuffers.size > 0) {
      for (const [idx, buf] of [...tcBuffers.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: 'tool_call', id: buf.id || `or_${idx}`, name: buf.name, args: parseArgs(buf.argsJson) };
      }
    }

    yield { type: 'done' };
  }
}
