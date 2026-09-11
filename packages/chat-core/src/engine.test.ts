import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@mediabox/contracts';
import { streamChat, runChat } from './engine.js';
import type { LLMStreamChunk, StreamProvider } from './providers/types.js';
import type { ChatMessage, HistoryStore, McpCallFn } from './types.js';

type ChoicesEvent = Extract<ChatEvent, { type: 'choices' }>;
type ToolEndEvent = Extract<ChatEvent, { type: 'tool-end' }>;

/** Provider that replays scripted chunks — one script per LLM turn. */
function scriptedProvider(turns: LLMStreamChunk[][]) {
  const seen: Array<{ messages: ChatMessage[]; tools: string[] }> = [];
  const exhausted: LLMStreamChunk[] = [{ type: 'text', text: '(script exhausted)' }];
  let turn = 0;
  const provider: StreamProvider = {
    providerName: 'openrouter',
    model: 'scripted',
    async *stream(opts) {
      seen.push({ messages: [...opts.messages], tools: opts.tools.map(t => t.name) });
      const script = turns[turn] ?? exhausted;
      turn++;
      for (const chunk of script) yield chunk;
      yield { type: 'done' };
    },
  };
  return { provider, seen };
}

function memoryStore(): HistoryStore {
  const store = new Map<string, ChatMessage[]>();
  return {
    get: id => {
      if (!store.has(id)) store.set(id, []);
      return store.get(id) as ChatMessage[];
    },
    set: (id, h) => { store.set(id, h); },
    delete: id => { store.delete(id); },
  };
}

function fakeMcp(responses: Record<string, string>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcpCall: McpCallFn = async (name, args) => {
    calls.push({ name, args });
    const r = responses[name];
    if (r === undefined) throw new Error(`fake mcp: unexpected tool ${name}`);
    return r;
  };
  return { mcpCall, calls };
}

async function collect(
  message: string,
  provider: StreamProvider,
  mcpCall: McpCallFn,
  historyStore: HistoryStore,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const evt of streamChat({ message, conversationId: 'conv-1', provider, mcpCall, historyStore, locale: 'en' })) {
    events.push(evt);
  }
  return events;
}

const toolEnd = (events: ChatEvent[]): ToolEndEvent | undefined =>
  events.find((e): e is ToolEndEvent => e.type === 'tool-end');

describe('streamChat — present_choices', () => {
  it('emits a choices event whose items carry typed selections built from mediaRef/releaseRef', async () => {
    const { provider, seen } = scriptedProvider([[
      { type: 'text', text: 'Which one?' },
      {
        type: 'tool_call', id: 'call-1', name: 'present_choices',
        args: {
          prompt: 'Pick a release',
          items: [
            { label: 'Bluray-1080p · Latino · 9.8 GB', subtitle: 'Seeders: 48', value: 'Download the Bluray-1080p Latino release', releaseRef: 'rref_abc', selectionType: 'select_release' },
            { label: 'Dark (2017)', value: 'Use Dark (2017)', mediaRef: 'mref_dark' },
            { label: 'Dark (2017) — bogus selection type', value: 'Use it', mediaRef: 'mref_dark2', selectionType: 'nonsense' },
            { label: 'Both refs', value: 'Propose it', mediaRef: 'mref_x', releaseRef: 'rref_x', selectionType: 'propose_download' },
            { label: 'Plain card', value: 'plain' },
          ],
        },
      },
    ]]);
    const { mcpCall, calls } = fakeMcp({});
    const store = memoryStore();

    const events = await collect('Download Dark', provider, mcpCall, store);

    const choices = events.find((e): e is ChoicesEvent => e.type === 'choices');
    expect(choices).toBeDefined();
    expect(choices?.prompt).toBe('Pick a release');
    expect(choices?.items).toHaveLength(5);
    expect(choices?.items[0].selection).toEqual({ type: 'select_release', releaseRef: 'rref_abc', value: 'Download the Bluray-1080p Latino release' });
    expect(choices?.items[1].selection).toEqual({ type: 'select_candidate', mediaRef: 'mref_dark', value: 'Use Dark (2017)' });
    expect(choices?.items[2].selection).toEqual({ type: 'select_candidate', mediaRef: 'mref_dark2', value: 'Use it' });
    expect(choices?.items[3].selection).toEqual({ type: 'propose_download', mediaRef: 'mref_x', releaseRef: 'rref_x', value: 'Propose it' });
    expect(choices?.items[4].selection).toBeUndefined();
    expect(choices?.items[4].value).toBe('plain');

    expect(calls).toHaveLength(0);                 // UI-only tool: no MCP call
    expect(seen).toHaveLength(1);                  // the turn ends after the cards
    expect(events.at(-1)).toEqual({ type: 'done', fullText: 'Which one?' });

    const history = store.get('conv-1');
    expect(history.at(-1)?.toolResults?.[0]).toEqual({ id: 'call-1', name: 'present_choices', result: '{"presented":true}' });
  });
});

describe('streamChat — tool failure detection', () => {
  it('reports tool-end ok:false for an error envelope and feeds the raw result back to the model', async () => {
    const { provider, seen } = scriptedProvider([
      [{ type: 'tool_call', id: 'call-1', name: 'catalog', args: { action: 'search', query: 'Dark', type: 'series' } }],
      [{ type: 'text', text: 'The catalog is unavailable right now.' }],
    ]);
    const envelope = '{"schemaVersion":1,"requestId":"r1","status":"error","data":[],"sources":[],"error":{"code":"UPSTREAM_DOWN","message":"Sonarr unreachable"}}';
    const { mcpCall, calls } = fakeMcp({ search_media: envelope });

    const events = await collect('Find Dark', provider, mcpCall, memoryStore());

    expect(calls).toEqual([{ name: 'search_media', args: { query: 'Dark', type: 'series' } }]); // routed to the real read tool
    const end = toolEnd(events);
    expect(end).toMatchObject({ name: 'catalog', ok: false, callId: 'call-1' });
    expect(end?.error).toContain('Sonarr unreachable');
    expect(seen).toHaveLength(2);
    expect(seen[1].messages.at(-1)?.toolResults?.[0].result).toBe(envelope);
    expect(events.at(-1)).toEqual({ type: 'done', fullText: 'The catalog is unavailable right now.' });
  });

  it('treats a result whose only "error" is inside a title as success', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'call-1', name: 'media_query', args: { action: 'search', query: 'Trial and Error', type: 'Series' } }],
      [{ type: 'text', text: 'Found it.' }],
    ]);
    const { mcpCall, calls } = fakeMcp({ jellyfin_search: '[{"title":"Trial and Error"}]' });

    const events = await collect('Do I have Trial and Error?', provider, mcpCall, memoryStore());

    expect(calls[0]?.name).toBe('jellyfin_search');
    const end = toolEnd(events);
    expect(end).toMatchObject({ name: 'media_query', ok: true });
    expect(end).not.toHaveProperty('error');
    expect(events.at(-1)).toEqual({ type: 'done', fullText: 'Found it.' });
  });

  it('flags MCP isError wrappers', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'call-1', name: 'operations', args: { action: 'status', planId: 'nope' } }],
      [{ type: 'text', text: 'That plan does not exist.' }],
    ]);
    const { mcpCall } = fakeMcp({ operation_status: '{"isError":true,"error":"Operation plan \'nope\' not found."}' });

    const events = await collect('status of plan nope', provider, mcpCall, memoryStore());

    expect(toolEnd(events)).toMatchObject({ name: 'operations', ok: false, error: "Operation plan 'nope' not found." });
  });
});

describe('streamChat — routing safety', () => {
  it('never calls MCP for a blocked virtual action and reports the routing error to the model', async () => {
    const { provider, seen } = scriptedProvider([
      [{ type: 'tool_call', id: 'call-1', name: 'movies', args: { action: 'grab', guid: 'g', indexerId: 1, movieId: 5 } }],
      [{ type: 'text', text: 'I cannot grab releases directly — let me propose a download instead.' }],
    ]);
    const { mcpCall, calls } = fakeMcp({});

    const events = await collect('grab it', provider, mcpCall, memoryStore());

    expect(calls).toHaveLength(0);
    const end = toolEnd(events);
    expect(end).toMatchObject({ name: 'movies', ok: false });
    expect(end?.error).toMatch(/Unknown virtual tool: movies\.grab/);
    expect(seen[1].messages.at(-1)?.toolResults?.[0].result).toContain('Unknown virtual tool');
  });

  it('routes catalog propose_download to the proposal tool and reports success', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'tool_call', id: 'call-1', name: 'catalog', args: { action: 'propose_download', releaseRef: 'rref_1', mediaRef: 'mref_1' } }],
      [{ type: 'text', text: 'Proposed — approve it in the Mediabox app.' }],
    ]);
    const plan = '{"planId":"plan-1","operation":"media_download","status":"awaiting_approval","expiresAt":"2026-09-10T00:10:00Z"}';
    const { mcpCall, calls } = fakeMcp({ propose_download: plan });

    const events = await collect('Download it', provider, mcpCall, memoryStore());

    expect(calls).toEqual([{ name: 'propose_download', args: { releaseRef: 'rref_1', mediaRef: 'mref_1' } }]);
    expect(toolEnd(events)).toMatchObject({ name: 'catalog', ok: true });
  });
});

describe('runChat', () => {
  it('returns the final text of a plain reply', async () => {
    const { provider } = scriptedProvider([[{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there.' }]]);
    const { mcpCall } = fakeMcp({});

    const text = await runChat({ message: 'hi', conversationId: 'conv-2', provider, mcpCall, historyStore: memoryStore(), locale: 'es' });

    expect(text).toBe('Hello there.');
  });
});
