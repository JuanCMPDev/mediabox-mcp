import OpenAI from 'openai';
import type { StreamProvider, LLMStreamChunk } from './types.js';
import type { ChatMessage, VirtualToolDef } from '../types.js';
import { buildOpenRouterMessages } from '../history.js';

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
  }): AsyncGenerator<LLMStreamChunk> {
    const { messages, tools } = buildOpenRouterMessages(opts.messages, opts.tools, opts.systemPrompt);

    const raw = await this.client.chat.completions.create({
      model:       this.model,
      messages,
      tools:       tools.length ? tools : undefined,
      temperature: 0.3,
      stream:      true,
    });

    // Accumulate tool call fragments across chunks (OpenAI sends args in pieces)
    const tcBuffers = new Map<number, { id: string; name: string; argsJson: string }>();

    for await (const chunk of raw) {
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

      if (chunk.choices[0]?.finish_reason === 'tool_calls') {
        for (const buf of tcBuffers.values()) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(buf.argsJson); } catch {}
          yield { type: 'tool_call', id: buf.id, name: buf.name, args };
        }
      }
    }

    yield { type: 'done' };
  }
}
