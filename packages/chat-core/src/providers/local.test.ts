/* ─── LocalProvider and runtime normalisation (LOC-02 / LOC-05 / LOC-08) ────
 * The SSE normaliser is driven with the fragment shapes each runtime actually
 * emits, so the quirks table in §3.6 is covered without a network mock.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { LocalProvider, normalizeChatCompletionStream, INVALID_TOOL_ARGS_KEY, RUNTIME_QUIRKS } from './local.js';
import type { LLMStreamChunk } from './types.js';
import type { LocalRuntimeKind } from '@mediabox/contracts';

const servers: Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const key of [
    'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_RUNTIME', 'LOCAL_LLM_API_KEY',
    'LOCAL_LLM_CONTEXT_TOKENS', 'LOCAL_BASE_URL', 'LOCAL_MODEL', 'LOCAL_RUNTIME',
  ]) delete process.env[key];
});

function sse(...events: string[]): string[] {
  return events.map(e => `data: ${e}\n\n`);
}

async function collect(
  lines: string[],
  runtime: LocalRuntimeKind,
  inferenceIndex = 0,
): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const chunk of normalizeChatCompletionStream(lines, { runtime, inferenceIndex })) {
    out.push(chunk);
  }
  return out;
}

const toolCalls = (chunks: LLMStreamChunk[]) => chunks.filter(c => c.type === 'tool_call') as Array<Extract<LLMStreamChunk, { type: 'tool_call' }>>;
const text = (chunks: LLMStreamChunk[]) =>
  chunks.filter(c => c.type === 'text').map(c => (c as any).text).join('');
const reasoning = (chunks: LLMStreamChunk[]) =>
  chunks.filter(c => c.type === 'text').map(c => (c as any).reasoning ?? '').join('');

describe('Runtime quirk normalisation (LOC-08)', () => {
  it('Ollama: assembles split arguments and synthesises a deterministic id when none arrives', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"catalog","arguments":"{\\"action\\":\\"sea"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"rch\\",\\"query\\":\\"Dark\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
      'ollama',
      2,
    );

    const calls = toolCalls(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('local_2_0');
    expect(calls[0].name).toBe('catalog');
    expect(calls[0].args).toEqual({ action: 'search', query: 'Dark' });
  });

  it('LM Studio: emits buffered tool calls even when finish_reason is stop', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"lm-1","function":{"name":"catalog","arguments":"{\\"action\\":\\"details\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      'lmstudio',
    );

    const calls = toolCalls(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('lm-1');
    expect(calls[0].args).toEqual({ action: 'details' });
  });

  it('llama.cpp: parses a <tool_call> block emitted as plain text', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"catalog\\",\\"arguments\\":{\\"action\\":\\"search\\"}}</tool_call>"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      'llamacpp',
    );

    const calls = toolCalls(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('catalog');
    expect(calls[0].args).toEqual({ action: 'search' });
    expect(RUNTIME_QUIRKS.llamacpp.hermesXmlToolCalls).toBe(true);
  });

  it('vLLM: keeps reasoning_content out of the answer text', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"reasoning_content":"weighing options"}}]}',
        '{"choices":[{"delta":{"content":"Here it is."}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      'vllm',
    );

    expect(text(chunks)).toBe('Here it is.');
    expect(reasoning(chunks)).toBe('weighing options');
  });

  it('separates multiple inline <think> blocks from the answer', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"content":"<think>first</think>Hello <think>second</think>world"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      'ollama',
    );

    expect(text(chunks)).toBe('Hello world');
    expect(reasoning(chunks)).toBe('firstsecond');
  });

  it('splits a <think> block that spans two fragments', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"content":"<think>thinking "}}]}',
        '{"choices":[{"delta":{"content":"still</think>Answer"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      'ollama',
    );

    expect(text(chunks)).toBe('Answer');
    expect(reasoning(chunks)).toBe('thinking still');
  });

  it('captures usage for the token counter', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"usage":{"prompt_tokens":42,"completion_tokens":12,"total_tokens":54}}',
        '[DONE]',
      ),
      'ollama',
    );
    const usage = chunks.find(c => c.type === 'usage') as any;
    expect(usage.usage.prompt_tokens).toBe(42);
  });
});

describe('Tool call integrity (LOC-02)', () => {
  it('never duplicates calls when the terminal chunk repeats', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"catalog","arguments":"{\\"action\\":\\"search\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
      'ollama',
    );
    expect(toolCalls(chunks)).toHaveLength(1);
  });

  it('keeps two parallel calls distinct and ordered by index', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"operations","arguments":"{\\"action\\":\\"status\\"}"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"catalog","arguments":"{\\"action\\":\\"search\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
      'ollama',
      1,
    );
    const calls = toolCalls(chunks);
    expect(calls.map(c => c.name)).toEqual(['catalog', 'operations']);
    expect(calls.map(c => c.id)).toEqual(['local_1_0', 'local_1_1']);
  });

  it('marks unparseable arguments as invalid instead of collapsing them to {}', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"catalog","arguments":"{\\"action\\":\\"sea"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
      'ollama',
    );
    const call = toolCalls(chunks)[0];
    expect(call.args).toEqual({ [INVALID_TOOL_ARGS_KEY]: '{"action":"sea' });
    expect(call.args).not.toEqual({});
  });

  it('treats a length-truncated call as invalid even when the JSON happens to parse', async () => {
    const chunks = await collect(
      sse(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"catalog","arguments":"{\\"action\\":\\"search\\"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"length"}]}',
        '[DONE]',
      ),
      'ollama',
    );
    expect(Object.keys(toolCalls(chunks)[0].args)).toEqual([INVALID_TOOL_ARGS_KEY]);
  });
});

describe('Stream termination (§3.6)', () => {
  it('accepts a clean close without [DONE]', async () => {
    const chunks = await collect(
      [
        'data: {"choices":[{"delta":{"content":"All good."}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ],
      'ollama',
    );
    expect(text(chunks)).toBe('All good.');
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });

  it('flushes tool calls a runtime never terminated explicitly', async () => {
    const chunks = await collect(
      ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"catalog","arguments":"{}"}}]}}]}\n\n'],
      'ollama',
    );
    expect(toolCalls(chunks)).toHaveLength(1);
  });

  it('raises ERR_PROVIDER_PROTOCOL when the stream is cut mid-fragment', async () => {
    await expect(
      collect(['data: {"choices":[{"delta":{"content":"half of a js'], 'ollama'),
    ).rejects.toThrow(/mid-fragment/);
  });

  it('raises ERR_PROVIDER_PROTOCOL when the runtime closes with no content at all', async () => {
    await expect(collect([''], 'ollama')).rejects.toThrow(/without emitting any content/);
  });

  it('surfaces a runtime error payload as a protocol error', async () => {
    await expect(
      collect(sse('{"error":{"message":"model not found"}}'), 'ollama'),
    ).rejects.toThrow(/model not found/);
  });
});

describe('LocalProvider configuration and endpoint safety', () => {
  it('reads the canonical LOCAL_LLM_* variables and falls back to the short aliases', () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:1234';
    process.env.LOCAL_LLM_MODEL = 'qwen2.5-7b-instruct';
    process.env.LOCAL_LLM_RUNTIME = 'lmstudio';
    process.env.LOCAL_LLM_CONTEXT_TOKENS = '4096';
    const canonical = new LocalProvider();
    expect(canonical.baseUrl).toBe('http://127.0.0.1:1234');
    expect(canonical.model).toBe('qwen2.5-7b-instruct');
    expect(canonical.runtime).toBe('lmstudio');
    expect(canonical.configuredContextTokens).toBe(4096);

    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.LOCAL_LLM_RUNTIME;
    process.env.LOCAL_BASE_URL = 'http://127.0.0.1:8080';
    process.env.LOCAL_MODEL = 'legacy-model';
    process.env.LOCAL_RUNTIME = 'llamacpp';
    const legacy = new LocalProvider();
    expect(legacy.baseUrl).toBe('http://127.0.0.1:8080');
    expect(legacy.model).toBe('legacy-model');
    expect(legacy.runtime).toBe('llamacpp');
  });

  it('instantiates with expected default values', () => {
    const provider = new LocalProvider();
    expect(provider.providerName).toBe('local');
    expect(provider.runtime).toBe('ollama');
    expect(provider.baseUrl).toBe('http://127.0.0.1:11434');
    expect(provider.model).toBe('qwen2.5:7b');
    expect(provider.contextTokens).toBe(8192);
  });

  it('refuses a cloud-hosted model name (INV-LOCAL)', () => {
    expect(() => new LocalProvider({ model: 'qwen3-coder:480b-cloud' })).toThrow(/cloud-hosted model/);
  });

  it('rejects public endpoints before opening a connection', async () => {
    const provider = new LocalProvider({ baseUrl: 'http://8.8.8.8:11434' });
    await expect(async () => {
      for await (const _ of provider.stream({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] })) { /* drain */ }
    }).rejects.toThrow(/not loopback/);
  });

  it('fails with ERR_PROVIDER_UNAVAILABLE when the runtime is unreachable, never a cloud fallback', async () => {
    const provider = new LocalProvider({ baseUrl: 'http://127.0.0.1:39999' });
    await expect(async () => {
      for await (const _ of provider.stream({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [] })) { /* drain */ }
    }).rejects.toThrow(/is unavailable/);
  });
});

describe('LocalProvider over HTTP', () => {
  function startRuntime(handler: (req: any, res: any) => void): Promise<number> {
    return new Promise(resolve => {
      const server = createServer(handler);
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
    });
  }

  it('sends max_tokens, temperature and the api key, and streams a tool call', async () => {
    let body: any;
    let auth: string | undefined;
    const port = await startRuntime((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        body = JSON.parse(raw);
        auth = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Working"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"catalog","arguments":"{\\"action\\":\\"search\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
        res.write('data: {"usage":{"prompt_tokens":42,"completion_tokens":12}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    const provider = new LocalProvider({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'lm-studio-key',
      probeRuntime: false,
    });
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of provider.stream({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
      maxTokens: 1024,
    })) {
      chunks.push(chunk);
    }

    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(true);
    expect(auth).toBe('Bearer lm-studio-key');
    expect(text(chunks)).toBe('Working');
    expect(toolCalls(chunks)[0].name).toBe('catalog');
    expect((chunks.find(c => c.type === 'usage') as any).usage.prompt_tokens).toBe(42);
  });

  it('clips the configured context to what Ollama reports (LOC-05)', async () => {
    const port = await startRuntime((req, res) => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          capabilities: ['completion', 'tools'],
          model_info: { 'qwen2.arch': 'qwen2', 'qwen2.context_length': 4096 },
        }));
        return;
      }
      res.writeHead(404); res.end();
    });

    const provider = new LocalProvider({ baseUrl: `http://127.0.0.1:${port}`, contextTokens: 8192 });
    const result = await provider.ensureRuntimeContext();

    expect(result.effectiveContextTokens).toBe(4096);
    expect(provider.contextTokens).toBe(4096);
    expect(result.warning).toMatch(/clipped to the runtime value/);
    expect(provider.diagnostics.runtimeContextTokens).toBe(4096);
  });

  it('reads n_ctx from llama.cpp /props', async () => {
    const port = await startRuntime((req, res) => {
      if (req.url === '/props') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ build_info: 'b4000', default_generation_settings: { n_ctx: 2048 } }));
        return;
      }
      res.writeHead(404); res.end();
    });

    const provider = new LocalProvider({ baseUrl: `http://127.0.0.1:${port}`, runtime: 'llamacpp', contextTokens: 8192 });
    await provider.ensureRuntimeContext();
    expect(provider.contextTokens).toBe(2048);
  });

  it('warns when the runtime says the model has no tool support', async () => {
    const port = await startRuntime((req, res) => {
      if (req.url === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities: ['completion'], model_info: { 'qwen2.context_length': 8192 } }));
        return;
      }
      res.writeHead(404); res.end();
    });

    const provider = new LocalProvider({ baseUrl: `http://127.0.0.1:${port}` });
    const result = await provider.ensureRuntimeContext();
    expect(result.warning).toMatch(/no tool support/);
  });

  it('stops the stream when the turn is aborted', async () => {
    const port = await startRuntime((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      // Never finishes: the abort must end it.
    });

    const controller = new AbortController();
    const provider = new LocalProvider({ baseUrl: `http://127.0.0.1:${port}`, probeRuntime: false });
    const received: string[] = [];

    await expect(async () => {
      for await (const chunk of provider.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: controller.signal,
      })) {
        if (chunk.type === 'text' && chunk.text) {
          received.push(chunk.text);
          controller.abort();
        }
      }
    }).rejects.toThrow();

    expect(received).toEqual(['first']);
  });
});
