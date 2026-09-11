/* ─── Local Multi-Backend Inference Provider ──────────────────────────────
 * Speaks OpenAI-compatible Chat Completions to local runtimes (§3.1, §3.5 / LOC-01..10).
 * Supports Ollama, LM Studio, llama.cpp and vLLM with runtime-specific quirks and SSRF safety.
 *
 * The SSE normaliser is exported separately from the HTTP client so every runtime
 * quirk can be replayed from captured fragments without a network mock (LOC-02/08).
 * ──────────────────────────────────────────────────────────────────────── */
import type { LocalRuntimeKind } from '@mediabox/contracts';
import type { StreamProvider, LLMStreamChunk, LLMUsage } from './types.js';
import type { ChatMessage, VirtualToolDef } from '../types.js';
import { buildOpenRouterMessages } from '../history.js';
import { AgentError } from '../agent/errors.js';
import { safeInferenceFetch, type EndpointPolicyOptions } from './endpoint-policy.js';
import { readRuntimeContext } from './runtime-probe.js';

/** Marker key for tool arguments that did not parse: never `{}` (§3.6). */
export const INVALID_TOOL_ARGS_KEY = '__invalid_tool_arguments';

export interface RuntimeQuirks {
  /** Emit buffered tool calls when finish_reason is `stop` (LM Studio). */
  toolCallsOnStop: boolean;
  /** The runtime exposes a token counter endpoint. */
  hasTokenizeEndpoint: boolean;
  /** Parse `<tool_call>{…}</tool_call>` out of plain text (llama.cpp without a tools template). */
  hermesXmlToolCalls: boolean;
}

export const RUNTIME_QUIRKS: Record<LocalRuntimeKind, RuntimeQuirks> = {
  ollama:              { toolCallsOnStop: true,  hasTokenizeEndpoint: false, hermesXmlToolCalls: false },
  lmstudio:            { toolCallsOnStop: true,  hasTokenizeEndpoint: false, hermesXmlToolCalls: false },
  llamacpp:            { toolCallsOnStop: true,  hasTokenizeEndpoint: true,  hermesXmlToolCalls: true },
  vllm:                { toolCallsOnStop: false, hasTokenizeEndpoint: true,  hermesXmlToolCalls: false },
  lemonade:            { toolCallsOnStop: true,  hasTokenizeEndpoint: false, hermesXmlToolCalls: false },
  'openai-compatible': { toolCallsOnStop: true,  hasTokenizeEndpoint: false, hermesXmlToolCalls: false },
};

export interface LocalProviderOptions {
  baseUrl?: string;            // Default: http://127.0.0.1:11434
  model?: string;              // Default: qwen2.5:7b
  runtime?: LocalRuntimeKind;  // Default: 'ollama'
  allowLan?: boolean;
  endpointHosts?: string[];
  apiKey?: string;
  contextTokens?: number;      // Default: 8192
  temperature?: number;        // Default: 0.2
  timeoutMs?: number;
  /** Set false in tests to skip the runtime context probe. */
  probeRuntime?: boolean;
}

interface ToolCallBuffer {
  id: string;
  name: string;
  argsJson: string;
}

export interface NormalizeOptions {
  runtime: LocalRuntimeKind;
  /** Index of the inference inside the turn — makes synthesised ids deterministic. */
  inferenceIndex: number;
  hermesXmlToolCalls?: boolean;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return { [INVALID_TOOL_ARGS_KEY]: trimmed };
  } catch {
    // Never collapse unparseable arguments to {}: the engine must see them as
    // invalid so its single repair applies (§2.5 / §3.6).
    return { [INVALID_TOOL_ARGS_KEY]: trimmed };
  }
}

/**
 * Normalises an OpenAI-compatible SSE byte/text stream into engine chunks,
 * absorbing the per-runtime differences listed in §3.6.
 */
export async function* normalizeChatCompletionStream(
  chunks: AsyncIterable<string> | Iterable<string>,
  opts: NormalizeOptions,
): AsyncGenerator<LLMStreamChunk> {
  const quirks = RUNTIME_QUIRKS[opts.runtime] ?? RUNTIME_QUIRKS['openai-compatible'];
  const hermes = opts.hermesXmlToolCalls ?? quirks.hermesXmlToolCalls;

  const tcBuffers = new Map<number, ToolCallBuffer>();
  let buffer = '';
  let inThinkTag = false;
  let sawTerminal = false;
  let sawDone = false;
  let emittedToolCalls = 0;
  let plainText = '';

  const flushToolCalls = function* (reason: string): Generator<LLMStreamChunk> {
    if (tcBuffers.size === 0) return;
    const entries = [...tcBuffers.entries()].sort((a, b) => a[0] - b[0]);
    // Clear before emitting so a repeated terminal chunk cannot double-emit (LOC-02).
    tcBuffers.clear();
    for (const [idx, buf] of entries) {
      const args = parseToolArguments(buf.argsJson);
      if (reason === 'length' && buf.argsJson.trim().length > 0 && !(INVALID_TOOL_ARGS_KEY in args)) {
        // Truncated generation: arguments cannot be trusted even if they parse.
        yield {
          type: 'tool_call',
          id: buf.id || `local_${opts.inferenceIndex}_${idx}`,
          name: buf.name,
          args: { [INVALID_TOOL_ARGS_KEY]: buf.argsJson.trim() },
        };
      } else {
        yield {
          type: 'tool_call',
          id: buf.id || `local_${opts.inferenceIndex}_${idx}`,
          name: buf.name,
          args,
        };
      }
      emittedToolCalls++;
    }
  };

  const handleEvent = function* (dataStr: string): Generator<LLMStreamChunk> {
    let chunkJson: any;
    try {
      chunkJson = JSON.parse(dataStr);
    } catch {
      return; // Keep-alives and non-JSON payloads are ignored
    }

    if (chunkJson.usage) {
      const usage: LLMUsage = {
        prompt_tokens: chunkJson.usage.prompt_tokens,
        completion_tokens: chunkJson.usage.completion_tokens,
        total_tokens: chunkJson.usage.total_tokens,
      };
      yield { type: 'usage', usage };
    }

    if (chunkJson.error) {
      const message = typeof chunkJson.error === 'string'
        ? chunkJson.error
        : chunkJson.error?.message ?? JSON.stringify(chunkJson.error).slice(0, 200);
      throw new AgentError('ERR_PROVIDER_PROTOCOL', `Local runtime reported an error: ${message}`);
    }

    const choice = chunkJson.choices?.[0];
    if (!choice) return;

    const delta = choice.delta ?? choice.message;
    if (delta) {
      // Reasoning arrives out of band on vLLM/LM Studio and inline on others.
      const reasoningField = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoningField === 'string' && reasoningField.length > 0) {
        yield { type: 'text', text: '', reasoning: reasoningField };
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        let rest: string = delta.content;
        while (rest.length > 0) {
          if (inThinkTag) {
            const close = rest.indexOf('</think>');
            if (close === -1) {
              yield { type: 'text', text: '', reasoning: rest };
              rest = '';
            } else {
              const reasoning = rest.slice(0, close);
              if (reasoning) yield { type: 'text', text: '', reasoning };
              rest = rest.slice(close + '</think>'.length);
              inThinkTag = false;
            }
          } else {
            const open = rest.indexOf('<think>');
            if (open === -1) {
              plainText += rest;
              yield { type: 'text', text: rest };
              rest = '';
            } else {
              const before = rest.slice(0, open);
              if (before) {
                plainText += before;
                yield { type: 'text', text: before };
              }
              rest = rest.slice(open + '<think>'.length);
              inThinkTag = true;
            }
          }
        }
      }

      for (const tc of delta.tool_calls ?? []) {
        const idx = typeof tc.index === 'number' ? tc.index : tcBuffers.size;
        if (!tcBuffers.has(idx)) tcBuffers.set(idx, { id: '', name: '', argsJson: '' });
        const buf = tcBuffers.get(idx)!;
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') buf.argsJson += tc.function.arguments;
      }
    }

    const finish = choice.finish_reason;
    if (finish === null || finish === undefined) return;

    if (finish === 'tool_calls' || (quirks.toolCallsOnStop && finish === 'stop') || finish === 'length') {
      yield* flushToolCalls(finish);
    }
    sawTerminal = true;
  };

  for await (const raw of chunks as AsyncIterable<string>) {
    buffer += raw;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue; // SSE comments / pings
      if (!trimmed.startsWith('data:')) continue;

      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') {
        yield* flushToolCalls('done');
        sawDone = true;
        sawTerminal = true;
        break;
      }
      yield* handleEvent(dataStr);
    }

    if (sawDone) break;
  }

  if (!sawDone) {
    const residual = buffer.trim();
    if (residual.length > 0 && residual !== 'data: [DONE]' && residual !== 'data:[DONE]') {
      // Cut in the middle of a fragment: refuse to present a truncated answer as complete.
      throw new AgentError(
        'ERR_PROVIDER_PROTOCOL',
        `Local runtime stream ended mid-fragment after ${residual.length} unterminated characters`,
      );
    }
    // Clean EOF: flush anything the runtime never terminated explicitly.
    yield* flushToolCalls('eof');
    if (!sawTerminal && emittedToolCalls === 0 && plainText.trim().length === 0) {
      throw new AgentError('ERR_PROVIDER_PROTOCOL', 'Local runtime closed the stream without emitting any content');
    }
  }

  if (hermes && emittedToolCalls === 0 && plainText.includes('<tool_call>')) {
    yield* emitHermesToolCalls(plainText, opts.inferenceIndex);
  }

  yield { type: 'done' };
}

/** Parses `<tool_call>{…}</tool_call>` blocks emitted as plain text (§3.6). */
function* emitHermesToolCalls(text: string, inferenceIndex: number): Generator<LLMStreamChunk> {
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = re.exec(text)) !== null) {
    let name = '';
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(match[1]);
      name = typeof parsed.name === 'string' ? parsed.name : '';
      const rawArgs = parsed.arguments ?? parsed.parameters ?? {};
      args = typeof rawArgs === 'string' ? parseToolArguments(rawArgs) : (rawArgs as Record<string, unknown>);
    } catch {
      args = { [INVALID_TOOL_ARGS_KEY]: match[1] };
    }
    if (!name) continue;
    yield { type: 'tool_call', id: `local_${inferenceIndex}_h${idx}`, name, args };
    idx++;
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export class LocalProvider implements StreamProvider {
  readonly providerName = 'local' as const;
  readonly model: string;
  readonly runtime: LocalRuntimeKind;
  readonly baseUrl: string;
  /** Context configured by the profile, clipped to what the runtime reports (LOC-05). */
  readonly configuredContextTokens: number;
  private effectiveContextTokens: number;
  private runtimeContextTokens?: number;
  private contextWarning?: string;
  private contextProbed = false;
  private inferenceIndex = 0;
  private options: LocalProviderOptions;

  constructor(options: LocalProviderOptions = {}) {
    const env = process.env;
    this.baseUrl = (
      firstNonEmpty(options.baseUrl, env.LOCAL_LLM_BASE_URL, env.LOCAL_BASE_URL) ?? 'http://127.0.0.1:11434'
    ).replace(/\/+$/, '');
    this.model = firstNonEmpty(options.model, env.LOCAL_LLM_MODEL, env.LOCAL_MODEL) ?? 'qwen2.5:7b';
    this.runtime = (firstNonEmpty(options.runtime, env.LOCAL_LLM_RUNTIME, env.LOCAL_RUNTIME) ?? 'ollama') as LocalRuntimeKind;

    const envContext = Number(env.LOCAL_LLM_CONTEXT_TOKENS ?? '');
    this.configuredContextTokens =
      options.contextTokens ?? (Number.isFinite(envContext) && envContext > 0 ? envContext : 8192);
    this.effectiveContextTokens = this.configuredContextTokens;

    this.options = {
      ...options,
      apiKey: firstNonEmpty(options.apiKey, env.LOCAL_LLM_API_KEY),
    };

    // A cloud-tagged model contradicts INV-LOCAL and is refused by name (§3.5).
    assertNotCloudModel(this.model);
  }

  get contextTokens(): number {
    return this.effectiveContextTokens;
  }

  get diagnostics(): {
    baseUrl: string;
    runtime: LocalRuntimeKind;
    model: string;
    configuredContextTokens: number;
    runtimeContextTokens?: number;
    effectiveContextTokens: number;
    contextWarning?: string;
  } {
    return {
      baseUrl: this.baseUrl,
      runtime: this.runtime,
      model: this.model,
      configuredContextTokens: this.configuredContextTokens,
      runtimeContextTokens: this.runtimeContextTokens,
      effectiveContextTokens: this.effectiveContextTokens,
      contextWarning: this.contextWarning,
    };
  }

  private get policy(): EndpointPolicyOptions {
    return { allowLan: this.options.allowLan, allowedHosts: this.options.endpointHosts };
  }

  /**
   * Reads the context window the runtime actually serves and clips the profile to it
   * (LOC-05 / §6.1). Safe to call repeatedly; it probes once.
   */
  async ensureRuntimeContext(): Promise<{ effectiveContextTokens: number; warning?: string }> {
    if (this.contextProbed || this.options.probeRuntime === false) {
      return { effectiveContextTokens: this.effectiveContextTokens, warning: this.contextWarning };
    }
    this.contextProbed = true;
    try {
      const probe = await readRuntimeContext(this.runtime, this.baseUrl, this.model, {
        policy: this.policy,
        apiKey: this.options.apiKey,
      });
      this.runtimeContextTokens = probe.contextTokens;
      if (probe.supportsTools === false) {
        this.contextWarning = `Runtime ${this.runtime} reports that model '${this.model}' has no tool support; the agent cannot operate in local mode with it`;
      }
      if (probe.contextTokens && probe.contextTokens < this.configuredContextTokens) {
        this.effectiveContextTokens = probe.contextTokens;
        this.contextWarning =
          `Runtime reports a ${probe.contextTokens}-token context, below the configured ${this.configuredContextTokens}; ` +
          'the agent budget was clipped to the runtime value';
        console.warn(`[local-llm] ${this.contextWarning}`);
      }
    } catch (err) {
      this.contextWarning = `Could not read the runtime context window: ${(err as Error).message}`;
    }
    return { effectiveContextTokens: this.effectiveContextTokens, warning: this.contextWarning };
  }

  async *stream(opts: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: VirtualToolDef[];
    signal?: AbortSignal;
    maxTokens?: number;
  }): AsyncGenerator<LLMStreamChunk> {
    const { messages, tools } = buildOpenRouterMessages(opts.messages, opts.tools, opts.systemPrompt);
    const inferenceIndex = this.inferenceIndex++;

    const endpoint = this.baseUrl.endsWith('/v1')
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;

    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      temperature: this.options.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
      stream: true,
      stream_options: { include_usage: true },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;

    const response = await this.openStream(endpoint, requestBody, headers, opts.signal);

    if (!response.body) {
      throw new AgentError('ERR_PROVIDER_PROTOCOL', 'Local inference endpoint returned empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    async function* readChunks(): AsyncGenerator<string> {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
    }

    try {
      yield* normalizeChatCompletionStream(readChunks(), {
        runtime: this.runtime,
        inferenceIndex,
      });
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      // Cancel rather than only release: an abandoned stream must stop the runtime.
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * Opens the SSE response. A network failure before the first token may be retried
   * once; after the first token there is no retry at all (§3.6).
   */
  private async openStream(
    endpoint: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await safeInferenceFetch(
          endpoint,
          { method: 'POST', headers, body: JSON.stringify(body), signal },
          this.policy,
        );
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new AgentError(
            'ERR_PROVIDER_PROTOCOL',
            `Local inference endpoint returned HTTP ${response.status}: ${errorText.slice(0, 300)}`,
          );
        }
        return response;
      } catch (err: any) {
        if (err instanceof AgentError) throw err;
        if (signal?.aborted) throw new AgentError('ERR_CANCELLED', 'Local inference request was cancelled');
        lastError = err;
      }
    }
    throw new AgentError(
      'ERR_PROVIDER_UNAVAILABLE',
      `Local runtime at ${this.baseUrl} is unavailable: ${(lastError as Error)?.message ?? 'unknown error'}`,
      { details: { baseUrl: this.baseUrl, runtime: this.runtime, model: this.model } },
    );
  }
}

/** Cloud-hosted model names are refused in local mode (§3.5 / INV-LOCAL). */
export function assertNotCloudModel(model: string): void {
  if (/(^|[:\/-])cloud$/i.test(model.trim())) {
    throw new AgentError(
      'ERR_PROVIDER_UNAVAILABLE',
      `Model '${model}' is a cloud-hosted model; local inference must stay on the machine (INV-LOCAL)`,
    );
  }
}
