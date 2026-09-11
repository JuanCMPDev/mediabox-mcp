/* ─── Local Multi-Backend Inference Provider ──────────────────────────────
 * Speaks OpenAI-compatible Chat Completions to local runtimes (§3.1, §3.5 / LOC-01..10).
 * Supports Ollama, LM Studio, llama.cpp, vLLM with runtime-specific quirks and SSRF safety.
 * ──────────────────────────────────────────────────────────────────────── */
import type { LocalRuntimeKind } from '@mediabox/contracts';
import type { StreamProvider, LLMStreamChunk, LLMUsage } from './types.js';
import type { ChatMessage, VirtualToolDef } from '../types.js';
import { buildOpenRouterMessages } from '../history.js';
import { AgentError } from '../agent/errors.js';
import { safeInferenceFetch } from './endpoint-policy.js';

export interface LocalProviderOptions {
  baseUrl?: string;            // Default: http://127.0.0.1:11434
  model?: string;              // Default: qwen2.5:7b
  runtime?: LocalRuntimeKind;  // Default: 'ollama'
  allowLan?: boolean;
  contextTokens?: number;      // Default: 8192
  temperature?: number;        // Default: 0.2
  timeoutMs?: number;
}

export class LocalProvider implements StreamProvider {
  readonly providerName = 'local' as const;
  readonly model: string;
  readonly runtime: LocalRuntimeKind;
  readonly baseUrl: string;
  private options: LocalProviderOptions;

  constructor(options: LocalProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = options.model ?? process.env.LOCAL_MODEL ?? 'qwen2.5:7b';
    this.runtime = (options.runtime ?? (process.env.LOCAL_RUNTIME as LocalRuntimeKind) ?? 'ollama');
    this.options = options;
  }

  async *stream(opts: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: VirtualToolDef[];
  }): AsyncGenerator<LLMStreamChunk> {
    const { messages, tools } = buildOpenRouterMessages(opts.messages, opts.tools, opts.systemPrompt);

    const endpoint = this.baseUrl.endsWith('/v1')
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;

    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: this.options.temperature ?? 0.2,
      stream: true,
      stream_options: { include_usage: true },
    };

    // Runtime-specific quirk: Ollama num_ctx
    if (this.runtime === 'ollama' && this.options.contextTokens) {
      requestBody.options = { num_ctx: this.options.contextTokens };
    }

    let response: Response;
    try {
      response = await safeInferenceFetch(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
          },
          body: JSON.stringify(requestBody),
        },
        { allowLan: this.options.allowLan },
      );
    } catch (err: any) {
      if (err instanceof AgentError) throw err;
      throw new AgentError(
        'ERR_PROVIDER_UNAVAILABLE',
        `Local runtime at ${this.baseUrl} is unavailable: ${err.message}`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new AgentError(
        'ERR_PROVIDER_PROTOCOL',
        `Local inference endpoint returned HTTP ${response.status}: ${errorText.slice(0, 300)}`,
      );
    }

    if (!response.body) {
      throw new AgentError('ERR_PROVIDER_PROTOCOL', 'Local inference endpoint returned empty response body');
    }

    // Accumulate tool call fragments across chunks
    const tcBuffers = new Map<number, { id: string; name: string; argsJson: string }>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let inThinkTag = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // Skip SSE comments / pings

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6).trim();
            if (dataStr === '[DONE]') {
              yield { type: 'done' };
              return;
            }

            let chunkJson: any;
            try {
              chunkJson = JSON.parse(dataStr);
            } catch {
              continue; // Skip malformed SSE data lines
            }

            // Report usage if provided in chunk
            if (chunkJson.usage) {
              const usage: LLMUsage = {
                prompt_tokens: chunkJson.usage.prompt_tokens,
                completion_tokens: chunkJson.usage.completion_tokens,
                total_tokens: chunkJson.usage.total_tokens,
              };
              yield { type: 'usage', usage };
            }

            const choice = chunkJson.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            // Handle reasoning content (OpenAI/vLLM reasoning_content or <think> tags)
            if (delta.reasoning_content) {
              yield { type: 'text', text: '', reasoning: delta.reasoning_content };
            }

            if (delta.content) {
              let text = delta.content;

              // Parse <think>...</think> tags if model produces inline think tokens
              if (text.includes('<think>')) {
                inThinkTag = true;
                const parts = text.split('<think>');
                if (parts[0]) yield { type: 'text', text: parts[0] };
                text = parts[1] || '';
              }

              if (inThinkTag) {
                if (text.includes('</think>')) {
                  inThinkTag = false;
                  const parts = text.split('</think>');
                  if (parts[0]) yield { type: 'text', text: '', reasoning: parts[0] };
                  if (parts[1]) yield { type: 'text', text: parts[1] };
                } else {
                  yield { type: 'text', text: '', reasoning: text };
                }
              } else {
                yield { type: 'text', text };
              }
            }

            // Accumulate streaming tool calls
            for (const tc of delta.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              if (!tcBuffers.has(idx)) {
                tcBuffers.set(idx, { id: '', name: '', argsJson: '' });
              }
              const buf = tcBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) buf.argsJson += tc.function.arguments;
            }

            // Emit accumulated tool calls upon tool_calls finish_reason
            if (choice.finish_reason === 'tool_calls') {
              for (const buf of tcBuffers.values()) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(buf.argsJson);
                } catch {
                  // Fallback: raw invalid JSON will be caught and rejected by dispatch schema validation
                  args = { __raw: buf.argsJson };
                }
                yield {
                  type: 'tool_call',
                  id: buf.id || `call_${Math.random().toString(36).slice(2, 8)}`,
                  name: buf.name,
                  args,
                };
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done' };
  }
}
