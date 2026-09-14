import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@mediabox/contracts';
import { AgentRuntime, classifyIntent, extractEntitledReferences } from './runtime.js';
import { InMemoryHistoryStore } from '../history.js';
import { InMemoryWorkflowStore, createInitialWorkflowState, type WorkflowState } from './workflow.js';
import { ScriptedProvider, type ScriptedInference } from './replay/scripted-provider.js';
import { FakeMcp } from './replay/fake-mcp.js';
import { validateProposalGrounding } from './dispatch.js';

const clock = () => '2026-09-12T12:00:00.000Z';
const folder = 'tv/Órbita (2023)/Season 02';
const file = `${folder}/Órbita - S02E04.mkv`;
const neighbor = `${folder}/Órbita - S02E05.mkv`;
const call = (id: string, name: string, args: Record<string, unknown>): ScriptedInference =>
  [{ type: 'tool_call', id, name, args }];
const done: ScriptedInference = [{ type: 'text', text: 'Revisa el plan en la aplicación.' }];
const actions = (provider: ScriptedProvider, step: number, name: string): string[] =>
  (provider.seen[step].tools.find(t => t.name === name)?.parameters as any)?.properties?.action?.enum ?? [];
const offered = (provider: ScriptedProvider, step: number): string[] =>
  provider.seen[step].tools.flatMap(t => (t.parameters as any).properties?.action?.enum ?? []);

async function run(message: string, scripts: ScriptedInference[], fixtures: Record<string, unknown>, state?: WorkflowState) {
  const provider = new ScriptedProvider(scripts);
  const mcp = new FakeMcp(Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, JSON.stringify(v)])));
  const workflowStore = new InMemoryWorkflowStore();
  if (state) await workflowStore.set('flow', state);
  const events: ChatEvent[] = [];
  for await (const event of AgentRuntime.streamTurn({
    conversationId: 'flow', principalId: 'owner', installationId: 'test', message, provider,
    mcpCall: mcp.callFn, workflowStore, historyStore: new InMemoryHistoryStore(), clock,
  })) events.push(event);
  return { provider, mcp, events, state: (await workflowStore.get('flow'))! };
}

describe('Intent routing distinguishes reads from proposals', () => {
  it.each([
    ['¿Qué descargas hay en curso ahora mismo?', 'queue'],
    ['Show current downloads', 'queue'],
    ['¿Cuál es el estado de la descarga?', 'queue'],
    ['What is the download status?', 'queue'],
    ['¿Se descargó River Bend?', 'status'],
    ['¿Ya puedo ver Horizonte?', 'status'],
    ['¿En qué estado está el plan plan_123?', 'status'],
    ['Descarga Horizonte en 1080p', 'download'],
    ['Please download River Bend', 'download'],
    ['Convierte Órbita a HEVC', 'convert'],
    ['Convert River Bend to HEVC', 'convert'],
    ['Haz un remux de Horizonte a MKV', 'convert'],
    ['Analiza los subtítulos de Órbita', 'inspect'],
    ['Inspect the subtitle tracks in River Bend', 'inspect'],
    ['What codecs does River Bend use?', 'inspect'],
    ['¿Qué películas del año 2021 tengo?', 'library'],
    ['List all movies from 1998', 'library'],
    ['Which series do I have?', 'library'],
    ['¿Cuántos episodios de Órbita tengo descargados?', 'library'],
    ['¿Qué episodios de Órbita tengo con subtítulos?', 'library'],
    ['¿Cuánto espacio libre queda en el disco?', 'server'],
    ['Who is watching right now?', 'server'],
    ['Limpia los archivos temporales', 'maintenance'],
    ['Busca la película Horizonte', 'other'],
    ['Find River Bend', 'other'],
    ['Restaura el episodio desde cuarentena', 'owner_only'],
    ['Purge the quarantine', 'owner_only'],
    ['Borra definitivamente la cuarentena', 'owner_only'],
    ['Aprueba tú el plan', 'owner_only'],
  ])('%s → %s', (message, kind) => expect(classifyIntent(message)?.kind).toBe(kind));

  it('reads every queue through the dedicated read endpoint, without proposal or cancellation', async () => {
    const result = await run('¿Qué descargas están en curso?', [call('q', 'downloads', { action: 'list_queue' }), done], {
      download_queue: { status: 'partial', data: [], sources: [{ source: 'sonarr', completeness: 'unavailable' }] },
    });
    expect(result.mcp.ledger).toMatchObject([{ tool: 'download_queue', args: { source: 'all' } }]);
    expect(actions(result.provider, 0, 'downloads')).toEqual(['status', 'list_queue']);
    expect(result.state.proposals).toEqual([]);
    expect(result.events.some(e => e.type === 'guard')).toBe(false);
  });

  it('lists a library by year/type without searching for the year as a title', async () => {
    const result = await run('Which movies from 1998 do I have?', [call('l', 'media_query', { action: 'list', type: 'Movie', year: 1998 }), done], {
      jellyfin_search: { results: [{ id: 'river', name: 'River Bend', year: 1998 }], total: 1 },
    });
    expect(result.mcp.ledger).toMatchObject([{ tool: 'jellyfin_search', args: { type: 'Movie', year: 1998 } }]);
    expect(result.mcp.ledger[0].args).not.toHaveProperty('query');
    expect(result.state.proposals).toEqual([]);
  });

  it('answers an owner-only request from reads, with no proposal action and the owner instruction', async () => {
    const result = await run('Restaura desde la cuarentena el episodio 4 de Órbita', [done], {});
    expect(offered(result.provider, 0).filter(action => action.startsWith('propose'))).toEqual([]);
    expect(result.provider.seen[0].systemPrompt).toContain('done only by the owner in the Mediabox app');
    expect(result.mcp.ledger).toEqual([]);
    expect(result.state.proposals).toEqual([]);
  });
});

describe('File workflows keep prerequisites reachable', () => {
  it.each(['Borra el episodio 4 de Órbita temporada 2', 'Delete episode 4 of Órbita season 2'])('%s', async (message) => {
    const result = await run(message, [
      call('find', 'media_query', { action: 'search', query: 'Órbita', type: 'Series' }),
      call('list', 'library_ops', { action: 'list', path: folder }),
      call('plan', 'library_ops', { action: 'propose_delete', paths: [file] }), done,
    ], {
      jellyfin_search: { results: [{ id: 'orbita', name: 'Órbita', path: folder }] },
      manage_files: { path: folder, items: [{ name: 'Órbita - S02E04.mkv', type: 'file' }, { name: 'Órbita - S02E05.mkv', type: 'file' }, { name: 'Extras', type: 'dir' }] },
      propose_cleanup: { planId: 'plan_exact', operation: 'quarantine_files', status: 'awaiting_approval' },
    });
    expect(result.mcp.ledger.map(e => e.tool)).toEqual(['jellyfin_search', 'manage_files', 'propose_cleanup']);
    expect(result.mcp.ledger[2].args).toEqual({ paths: [file] });
    expect(actions(result.provider, 0, 'library_ops')).toEqual(['list']);
    expect(actions(result.provider, 2, 'library_ops')).toContain('propose_delete');
    expect(result.state.proposals).toMatchObject([{ planId: 'plan_exact', status: 'awaiting_approval' }]);
    expect(result.state.references.paths).not.toContain(`${folder}/Extras`);
  });

  it.each([
    ['Convierte Órbita a HEVC', 'transcode'],
    ['Remux Órbita to MKV', 'remux'],
    ['Convierte los subtítulos de Órbita a SRT', 'subtitle-convert'],
  ])('%s keeps listing and analysis after selecting a media reference', async (message, job) => {
    const initial = createInitialWorkflowState('flow', 'owner', 'test', clock);
    initial.phase = 'select';
    initial.intent = classifyIntent(message);
    initial.references = { mediaRef: 'mref_001122334455' };
    const result = await run(message, [
      call('list', 'library_ops', { action: 'list', path: folder }),
      call('analyze', 'media_format', { action: 'analyze', path: file }),
      call('plan', 'media_format', { action: 'propose', path: file, job }), done,
    ], {
      manage_files: { path: folder, items: [{ name: 'Órbita - S02E04.mkv', type: 'file' }] },
      inspect_format: { status: 'ok', data: { path: file, streams: [{ codec: 'h264' }] } },
      propose_media_job: { planId: 'plan_format', operation: 'media_format_conversion', status: 'awaiting_approval' },
    }, initial);
    expect(result.mcp.ledger.map(e => e.tool)).toEqual(['manage_files', 'inspect_format', 'propose_media_job']);
    expect(actions(result.provider, 0, 'media_format')).toEqual(['analyze']);
    expect(actions(result.provider, 1, 'media_format')).toEqual(['analyze']);
    expect(actions(result.provider, 2, 'media_format')).toContain('propose');
    expect(result.state.references.inspectedPaths).toEqual([file]);
    expect(result.state.proposals).toMatchObject([{ status: 'awaiting_approval' }]);
    for (const inference of result.provider.seen) expect(inference.tools.filter(t => t.name !== 'present_choices').length).toBeLessThanOrEqual(4);
  });

  it('inspection alone never exposes a conversion proposal', async () => {
    const result = await run('Inspect the tracks of Órbita', [call('inspect', 'media_format', { action: 'analyze', path: file }), done], {
      inspect_format: { status: 'ok', data: { path: file, streams: [] } },
    });
    expect(result.state.proposals).toEqual([]);
    expect(actions(result.provider, 1, 'media_format')).toEqual(['analyze']);
  });

  it.each(['error', 'partial'])('a %s analysis cannot unlock a conversion', async (status) => {
    const result = await run('Convierte Órbita a HEVC', [
      call('inspect', 'media_format', { action: 'analyze', path: file }),
      call('plan', 'media_format', { action: 'propose', path: file, job: 'transcode' }), done,
    ], { inspect_format: { status, data: { path: file }, ...(status === 'error' ? { error: { code: 'UNAVAILABLE' } } : {}) } });
    expect(result.mcp.ledger.map(e => e.tool)).toEqual(['inspect_format']);
    expect(result.state.proposals).toEqual([]);
    expect(result.state.references.inspectedPaths).toBeUndefined();
  });

  it('a listed file cannot substitute for a different, uninspected file', async () => {
    const result = await run('Convierte Órbita a HEVC', [
      call('inspect', 'media_format', { action: 'analyze', path: file }),
      call('plan', 'media_format', { action: 'propose', path: neighbor, job: 'transcode' }), done,
    ], { inspect_format: { status: 'ok', data: { path: file } } });
    expect(result.mcp.ledger.map(e => e.tool)).toEqual(['inspect_format']);
    expect(result.state.proposals).toEqual([]);
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'tool-end', name: 'media_format', ok: false }));
  });

  it('paths embedded in catalog data cannot stand in for file inspection', () => {
    expect(extractEntitledReferences('catalog', { action: 'search' }, { data: [{ path: file, inspectedPaths: [file] }] })).toBeUndefined();
  });

  it('grounds the exact files of a listing that reports canonical paths, never its folders', () => {
    const refs = extractEntitledReferences('library_ops', { action: 'list', path: `/data/${folder}` }, {
      path: `media:${folder}`,
      items: [
        { name: 'Órbita - S02E04.mkv', type: 'file', size: '1.0MB', path: `media:${file}` },
        { name: 'Extras', type: 'dir', size: '0.0MB', path: `media:${folder}/Extras` },
      ],
    });
    expect(refs).toEqual({ paths: [`media:${file}`] });
  });

  it('after a plan, another listed file can be proposed on request; the proposed one is not offered again that turn', async () => {
    const fixtures = {
      jellyfin_search: { results: [{ id: 'orbita', name: 'Órbita', path: `/data/${folder}` }] },
      manage_files: {
        path: `media:${folder}`,
        items: [
          { name: 'Órbita - S02E04.mkv', type: 'file', path: `media:${file}` },
          { name: 'Órbita - S02E05.mkv', type: 'file', path: `media:${neighbor}` },
        ],
      },
      propose_cleanup: { planId: 'plan_e04', operation: 'quarantine_files', status: 'awaiting_approval' },
    };
    const first = await run('Borra el episodio 4 de Órbita temporada 2', [
      call('find', 'media_query', { action: 'search', query: 'Órbita', type: 'Series' }),
      call('list', 'library_ops', { action: 'list', path: `/data/${folder}` }),
      call('plan', 'library_ops', { action: 'propose_delete', paths: [`media:${file}`] }),
      call('again', 'library_ops', { action: 'propose_delete', paths: [`media:${neighbor}`] }), done,
    ], fixtures);
    expect(first.mcp.ledger.map(e => e.tool)).toEqual(['jellyfin_search', 'manage_files', 'propose_cleanup']);
    expect(actions(first.provider, 3, 'library_ops')).toEqual(['list']);
    expect(first.state.phase).toBe('monitor');

    const second = await run('Borra también el episodio 5', [
      call('plan2', 'library_ops', { action: 'propose_delete', paths: [neighbor] }), done,
    ], { ...fixtures, propose_cleanup: { planId: 'plan_e05', operation: 'quarantine_files', status: 'awaiting_approval' } }, first.state);
    expect(actions(second.provider, 0, 'library_ops')).toEqual(['list', 'propose_delete']);
    expect(second.mcp.ledger).toMatchObject([{ tool: 'propose_cleanup', args: { paths: [neighbor] } }]);
    expect(second.state.proposals.map(p => p.planId)).toEqual(['plan_e04', 'plan_e05']);
  });

  it('converts two files in one turn, each through its own analysis', async () => {
    const job = (path: string) => JSON.stringify({ path, action: 'transcode', profileName: 'cpu_hevc_transcode' });
    const result = await run('Convierte los episodios 4 y 5 de Órbita a HEVC', [
      call('a4', 'media_format', { action: 'analyze', path: file }),
      call('p4', 'media_format', { action: 'propose', path: file, job: 'transcode' }),
      call('a5', 'media_format', { action: 'analyze', path: neighbor }),
      call('p5', 'media_format', { action: 'propose', path: neighbor, job: 'transcode' }), done,
    ], {
      [`inspect_format:${JSON.stringify({ path: file })}`]: { status: 'ok', data: { path: `media:${file}`, streams: [] } },
      [`inspect_format:${JSON.stringify({ path: neighbor })}`]: { status: 'ok', data: { path: `media:${neighbor}`, streams: [] } },
      [`propose_media_job:${job(file)}`]: { planId: 'plan_e04', operation: 'media_format_conversion', status: 'awaiting_approval' },
      [`propose_media_job:${job(neighbor)}`]: { planId: 'plan_e05', operation: 'media_format_conversion', status: 'awaiting_approval' },
    });
    expect(result.mcp.ledger.map(e => e.tool)).toEqual(['inspect_format', 'propose_media_job', 'inspect_format', 'propose_media_job']);
    expect(actions(result.provider, 2, 'media_format')).toEqual(['analyze']);
    expect(result.state.proposals.map(p => p.planId)).toEqual(['plan_e04', 'plan_e05']);
  });
});

describe('Downloads propose any verified release', () => {
  it('proposes any release and media the reads returned, not only the first ones', async () => {
    const result = await run('Descarga la película Eclipse de 2017', [
      call('s', 'catalog', { action: 'search', query: 'Eclipse', type: 'movie' }),
      call('r', 'catalog', { action: 'releases', mediaRef: 'mref_eclipse2017' }),
      call('p', 'catalog', { action: 'propose_download', releaseRef: 'rref_second0002', mediaRef: 'mref_eclipse2017' }), done,
    ], {
      search_media: { status: 'ok', data: [{ title: 'Eclipse', year: 2004, mediaRef: 'mref_eclipse2004' }, { title: 'Eclipse', year: 2017, mediaRef: 'mref_eclipse2017' }] },
      find_releases: { status: 'ok', data: [{ title: 'Eclipse.2017.720p', releaseRef: 'rref_first00001' }, { title: 'Eclipse.2017.1080p', releaseRef: 'rref_second0002' }] },
      propose_download: { planId: 'plan_eclipse', operation: 'media_download', status: 'awaiting_approval', proposalKey: 'k' },
    });
    expect(result.mcp.ledger.map(e => e.tool)).toEqual(['search_media', 'find_releases', 'propose_download']);
    expect(actions(result.provider, 1, 'catalog')).not.toContain('propose_download');
    expect(actions(result.provider, 2, 'catalog')).toContain('propose_download');
    expect(result.state.proposals).toMatchObject([{ planId: 'plan_eclipse' }]);
    expect(result.state.proposalTargets).toEqual({ plan_eclipse: ['rref_second0002'] });
  });

  it('a queue question in the middle of a download keeps the grounded release', async () => {
    const initial = createInitialWorkflowState('flow', 'owner', 'test', clock);
    initial.phase = 'select';
    initial.intent = classifyIntent('Descarga Horizonte en 1080p');
    initial.references = {
      mediaRef: 'mref_horizonte01', releaseRef: 'rref_horizonte01', releaseRefs: ['rref_horizonte01'], expiresAt: '2026-09-12T12:05:00.000Z',
    };
    const read = await run('¿Qué descargas hay en curso?', [call('q', 'downloads', { action: 'list_queue' }), done], {
      download_queue: { status: 'ok', data: { queues: [] }, sources: [] },
    }, initial);
    expect(read.state.intent?.kind).toBe('queue');
    expect(read.state.references.releaseRef).toBe('rref_horizonte01');

    const resumed = await run('Vale, descárgala', [
      call('p', 'catalog', { action: 'propose_download', releaseRef: 'rref_horizonte01', mediaRef: 'mref_horizonte01' }), done,
    ], { propose_download: { planId: 'plan_h', operation: 'media_download', status: 'awaiting_approval' } }, read.state);
    expect(actions(resumed.provider, 0, 'catalog')).toContain('propose_download');
    expect(resumed.mcp.ledger).toMatchObject([{ tool: 'propose_download' }]);
  });
});

describe('Proposal scope is checked before MCP dispatch', () => {
  it('rejects unlisted paths, different releases, and expired observations', () => {
    expect(validateProposalGrounding('library_ops', { action: 'propose_delete', paths: [neighbor] }, { paths: [file] }, clock()).valid).toBe(false);
    expect(validateProposalGrounding('catalog', { action: 'propose_download', releaseRef: 'rref_neighbor' }, { releaseRef: 'rref_selected' }, clock()).valid).toBe(false);
    expect(validateProposalGrounding('media_format', { action: 'propose', path: file }, { inspectedPaths: [file], expiresAt: '2026-09-12T11:59:59.000Z' }, clock()).valid).toBe(false);
    expect(validateProposalGrounding('media_format', { action: 'propose', path: file }, { paths: [file] }, clock()).valid).toBe(false);
  });

  it('matches the same file across the path forms the tools report', () => {
    const refs = { paths: [`media:${file}`], inspectedPaths: [`media:${file}`], expiresAt: '2026-09-12T12:10:00.000Z' };
    for (const form of [file, `media:${file}`, `/data/${file}`, file.replace(/\//g, '\\')]) {
      expect(validateProposalGrounding('library_ops', { action: 'propose_delete', paths: [form] }, refs, clock()).valid, form).toBe(true);
      expect(validateProposalGrounding('media_format', { action: 'propose', path: form }, refs, clock()).valid, form).toBe(true);
    }
    expect(validateProposalGrounding('library_ops', { action: 'propose_delete', paths: [`downloads/${file}`] }, refs, clock()).valid).toBe(false);
    expect(validateProposalGrounding('library_ops', { action: 'propose_delete', paths: [`media:${file}`, neighbor] }, refs, clock()).valid).toBe(false);
    expect(validateProposalGrounding('media_format', { action: 'propose', path: neighbor }, refs, clock()).valid).toBe(false);
  });

  it('accepts any observed release, but no release or media that a read did not return', () => {
    const refs = { mediaRefs: ['mref_seen000001'], releaseRefs: ['rref_first00001', 'rref_second0002'], releaseRef: 'rref_first00001' };
    const propose = (args: Record<string, unknown>) =>
      validateProposalGrounding('catalog', { action: 'propose_download', ...args }, refs, clock()).valid;
    expect(propose({ releaseRef: 'rref_second0002', mediaRef: 'mref_seen000001' })).toBe(true);
    expect(propose({ releaseRef: 'rref_second0002' })).toBe(true);
    expect(propose({ releaseRef: 'rref_pasted00001' })).toBe(false);
    expect(propose({ releaseRef: 'rref_first00001', mediaRef: 'mref_pasted00001' })).toBe(false);
  });
});
