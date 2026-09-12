/* ─── PR05 hardening of the local provider path (NET-04 / P11 §4.1) ──────────
 * - An endpoint name keeps its first validated address for the process
 *   lifetime: a later, different answer is refused as DNS rebinding.
 * - Sampling declared by the model profile reaches the runtime request.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { validateInferenceEndpoint, resetEndpointPinsForTesting } from './endpoint-policy.js';
import { resolveProvider } from './select.js';
import { readRuntimeContext } from './runtime-probe.js';
import { extractEntitledReferences } from '../agent/runtime.js';

describe('findings of the P11 harness', () => {
  beforeEach(() => resetEndpointPinsForTesting());

  it('a library_ops.list result provides the listed paths, so propose_delete can follow', () => {
    const parsed = { path: 'tv/Serie Ñandú (2024)/Season 01', items: [{ name: 'Serie Ñandú - S01E02.mkv', type: 'file' }] };
    expect(extractEntitledReferences('library_ops', { action: 'list' }, parsed)).toEqual({
      paths: ['tv/Serie Ñandú (2024)/Season 01/Serie Ñandú - S01E02.mkv'],
    });
  });

  it('the Ollama context is the served window, not the trained maximum', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/show') res.end(JSON.stringify({ capabilities: ['tools'], model_info: { 'qwen2.context_length': 32768 } }));
      else if (req.url === '/api/ps') res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', context_length: 4096 }] }));
      else res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    try {
      const info = await readRuntimeContext('ollama', `http://127.0.0.1:${port}`, 'qwen2.5:7b');
      expect(info.contextTokens).toBe(4096);
      expect(info.servedContextKnown).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('endpoint address pinning across requests (NET-04)', () => {
  beforeEach(() => resetEndpointPinsForTesting());

  it('refuses a name whose answer changes to another private address', async () => {
    const answers = ['192.168.50.20', '192.168.50.66'];
    const lookupFn = async () => ({ address: answers.shift()! });
    const opts = { allowLan: true, allowedHosts: ['inference.lan'], lookupFn };

    const first = await validateInferenceEndpoint('http://inference.lan:11434', opts);
    expect(first.resolvedIp).toBe('192.168.50.20');
    await expect(validateInferenceEndpoint('http://inference.lan:11434', opts)).rejects.toMatchObject({
      code: 'ERR_ENDPOINT_POLICY',
      message: expect.stringMatching(/DNS rebinding/),
    });
  });

  it('keeps accepting the same answer', async () => {
    const lookupFn = async () => ({ address: '192.168.50.20' });
    const opts = { allowLan: true, allowedHosts: ['inference.lan'], lookupFn };
    await validateInferenceEndpoint('http://inference.lan:11434', opts);
    await expect(validateInferenceEndpoint('http://inference.lan:11434/v1', opts)).resolves.toMatchObject({ resolvedIp: '192.168.50.20' });
  });

  it('a refused answer never becomes the pin', async () => {
    const answers = ['8.8.8.8', '192.168.50.20'];
    const lookupFn = async () => ({ address: answers.shift()! });
    const opts = { allowLan: true, allowedHosts: ['inference.lan'], lookupFn };
    await expect(validateInferenceEndpoint('http://inference.lan:11434', opts)).rejects.toMatchObject({ code: 'ERR_ENDPOINT_POLICY' });
    await expect(validateInferenceEndpoint('http://inference.lan:11434', opts)).resolves.toMatchObject({ resolvedIp: '192.168.50.20' });
  });
});

describe('sampling from the environment (P11 §4.1)', () => {
  it('sends the declared temperature and seed to the runtime', async () => {
    let body: any = null;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        body = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    try {
      const provider = resolveProvider({
        LLM_PROVIDER: 'local',
        LOCAL_LLM_BASE_URL: `http://127.0.0.1:${port}`,
        LOCAL_LLM_TEMPERATURE: '0',
        LOCAL_LLM_SEED: '42',
      });
      for await (const _ of provider.stream({ systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })) { /* drain */ }
      expect(body.temperature).toBe(0);
      expect(body.seed).toBe(42);
    } finally {
      server.close();
    }
  });

  it('omits the seed when none is declared and rejects out-of-range values', () => {
    expect(() => resolveProvider({ LLM_PROVIDER: 'local', LOCAL_LLM_TEMPERATURE: '3' })).toThrow(/LOCAL_LLM_TEMPERATURE/);
    expect(() => resolveProvider({ LLM_PROVIDER: 'local', LOCAL_LLM_SEED: '-1' })).toThrow(/LOCAL_LLM_SEED/);
    expect(() => resolveProvider({ LLM_PROVIDER: 'local' })).not.toThrow();
  });
});
