import { describe, it, expect } from 'vitest';
import { LocalProvider } from './local.js';
import { createServer } from 'node:http';

describe('LocalProvider (§3.1 / §3.5 / LOC-01..10)', () => {
  it('instantiates with expected default values', () => {
    const provider = new LocalProvider();
    expect(provider.providerName).toBe('local');
    expect(provider.runtime).toBe('ollama');
    expect(provider.baseUrl).toBe('http://127.0.0.1:11434');
    expect(provider.model).toBe('qwen2.5:7b');
  });

  it('rejects public endpoints with ERR_ENDPOINT_POLICY', async () => {
    const provider = new LocalProvider({ baseUrl: 'http://8.8.8.8:11434' });
    const stream = provider.stream({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });

    await expect(async () => {
      for await (const _ of stream) {}
    }).rejects.toThrow(/not permitted under policy/);
  });

  it('fails with ERR_PROVIDER_UNAVAILABLE when server is unreachable without cloud fallback', async () => {
    const provider = new LocalProvider({ baseUrl: 'http://127.0.0.1:39999' }); // unreachable port
    const stream = provider.stream({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });

    await expect(async () => {
      for await (const _ of stream) {}
    }).rejects.toThrow(/is unavailable/);
  });

  it('streams responses, parses tool calls, and extracts reasoning', async () => {
    // Spin up a mock local HTTP SSE server
    const server = createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Stream a reasoning chunk, text chunk, and tool call
      res.write(`data: {"choices":[{"delta":{"content":"<think>Reasoning here</think>Hello world"}}]}\n\n`);
      res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"catalog","arguments":"{\\"action\\":\\"search\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n`);
      res.write(`data: {"usage":{"prompt_tokens":42,"completion_tokens":12}}\n\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    try {
      const provider = new LocalProvider({ baseUrl: `http://127.0.0.1:${port}` });
      const chunks: any[] = [];

      for await (const chunk of provider.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'test' }],
        tools: [],
      })) {
        chunks.push(chunk);
      }

      const textChunk = chunks.find(c => c.type === 'text' && c.text === 'Hello world');
      expect(textChunk).toBeDefined();

      const reasoningChunk = chunks.find(c => c.reasoning === 'Reasoning here');
      expect(reasoningChunk).toBeDefined();

      const toolCallChunk = chunks.find(c => c.type === 'tool_call');
      expect(toolCallChunk).toBeDefined();
      expect(toolCallChunk.name).toBe('catalog');
      expect(toolCallChunk.args).toEqual({ action: 'search' });

      const usageChunk = chunks.find(c => c.type === 'usage');
      expect(usageChunk).toBeDefined();
      expect(usageChunk.usage.prompt_tokens).toBe(42);
    } finally {
      server.close();
    }
  });
});
