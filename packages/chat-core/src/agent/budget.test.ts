import { describe, it, expect } from 'vitest';
import {
  prepareContext, compactToolResult, buildStateSummary, DEFAULT_BUDGET, estimateTokenCount, TOOL_RESULT_TOKEN_CAP,
} from './budget.js';
import { createInitialWorkflowState } from './workflow.js';
import type { ChatMessage } from '../types.js';
import { AgentError } from './errors.js';

describe('Context Budget & Compaction (§2.4 / AGT-07)', () => {
  const state = createInitialWorkflowState('conv_1', 'p_1', 'inst_1');

  it('compacts large envelopes to at most 5 items and truncates long strings', () => {
    const rawResult = JSON.stringify({
      status: 'ok',
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `movie:${i}`,
        title: `Very Long Movie Title Number ${i} `.repeat(10),
        year: 2000 + i,
        extraUnneededField: 'ignored',
      })),
    });

    const compacted = compactToolResult('catalog', rawResult);
    const parsed = JSON.parse(compacted);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.length).toBe(5);
    expect(parsed.data[0].title.length).toBeLessThanOrEqual(124); // 120 + '...'
    expect(parsed.data[0].extraUnneededField).toBeUndefined();
  });

  it('builds state summary within 600 tokens', () => {
    const summary = buildStateSummary({
      ...state,
      intent: { kind: 'download', summary: 'Download Inception in 1080p' },
      references: { mediaRef: 'mref_1234567890ab', releaseRef: 'rref_1234567890ab' },
      proposals: [{ planId: 'plan_1', operation: 'download', status: 'awaiting_approval', manifestHash: 'h', proposalKey: 'k' }],
    });
    expect(Math.ceil(summary.length / 3.5)).toBeLessThanOrEqual(600);
  });

  it('rejects context overflow before calling provider (AGT-07)', () => {
    // If the system prompt itself is huge (> inputBudget 6656 tokens), prepareContext must throw ERR_CONTEXT_OVERFLOW
    const giantPrompt = 'A'.repeat(7000 * 4); // ~8000 tokens

    expect(() =>
      prepareContext({
        systemPrompt: giantPrompt,
        tools: [],
        state,
        history: [],
        budget: DEFAULT_BUDGET,
      }),
    ).toThrow(AgentError);

    try {
      prepareContext({
        systemPrompt: giantPrompt,
        tools: [],
        state,
        history: [],
        budget: DEFAULT_BUDGET,
      });
    } catch (err: any) {
      expect(err.code).toBe('ERR_CONTEXT_OVERFLOW');
    }
  });

  it('trims old history without cutting mid-exchange', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'Turn 1: hello' },
      { role: 'assistant', content: 'Turn 1 reply' },
      { role: 'user', content: 'Turn 2: query' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'catalog', args: { action: 'search' } }],
      },
      {
        role: 'user',
        content: '',
        toolResults: [{ id: 'tc1', name: 'catalog', result: '{"status":"ok","data":[]}' }],
      },
      { role: 'assistant', content: 'Turn 2 final reply' },
      { role: 'user', content: 'Turn 3: latest question' },
    ];

    const ctx = prepareContext({
      systemPrompt: 'You are an assistant.',
      tools: [],
      state,
      history,
      budget: { ...DEFAULT_BUDGET, inputBudget: 1000 },
    });

    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(ctx.estimatedTokens).toBeLessThanOrEqual(1000);
  });
});

/*
 * PR05 G10 found the model reading `[object]` for every nested record: search
 * hits, libraries, sessions and episodes. It then answered "no results" or sent
 * showId "[object]". The payloads below have the shapes of the real MCP tools.
 */
describe('Compaction keeps nested ids and names (PR05 G10)', () => {
  it('jellyfin_search: every hit keeps its id and name', () => {
    const raw = JSON.stringify({
      total: 3,
      results: ['Serie Ñandú', 'Los Guardianes del Puerto', 'Crónicas del Delta'].map((name, i) => ({
        id: `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d${i}`, name, type: 'Series', year: 2020 + i, series: null,
        path: `/data/tv/${name}`, episode: null,
      })),
      pagination: { page: 1, pageSize: 50, totalPages: 1, totalItems: 3, hasMore: false },
    }, null, 2);
    const compacted = compactToolResult('media_query', raw);
    expect(compacted).not.toContain('[object]');
    const parsed = JSON.parse(compacted);
    expect(parsed.total).toBe(3);
    expect(parsed.results.map((r: any) => r.name)).toEqual(['Serie Ñandú', 'Los Guardianes del Puerto', 'Crónicas del Delta']);
    expect(parsed.results[0].id).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d0');
  });

  it('server_status: libraries, active sessions and users stay readable', () => {
    const raw = JSON.stringify({
      server: { name: 'mediabox', version: '10.10.7', os: 'Linux' },
      disk: { path: '/data', total: '464.8 GB', used: '448.5 GB', free: '16.3 GB', usedPercent: 96 },
      libraries: [
        { name: 'Películas', type: 'movies', paths: ['/data/movies'], movies: 5 },
        { name: 'Series', type: 'tvshows', paths: ['/data/tv'], series: 3, episodes: 8 },
      ],
      activeSessions: [{ user: 'marta', device: 'TV', playing: 'Plumas', playMethod: 'DirectPlay', isPaused: false }],
      users: [{ name: 'marta', isAdmin: false, lastActive: '2026-09-12T05:00:00Z' }],
    });
    const parsed = JSON.parse(compactToolResult('server_info', raw));
    expect(parsed.libraries[1]).toMatchObject({ name: 'Series', series: 3, episodes: 8 });
    expect(parsed.activeSessions[0]).toMatchObject({ user: 'marta', playing: 'Plumas' });
    expect(parsed.users[0].name).toBe('marta');
  });

  it('show_details: episodes keep name and subtitles, and a cut list says how much is left', () => {
    const season = (number: number, count: number) => ({
      name: `Season ${number}`, number,
      episodes: Array.from({ length: count }, (_, i) => ({
        id: `ep${number}${i}`, number: i + 1, name: `Episodio ${i + 1}`, hasSubtitles: i === 0, path: `/data/tv/S${number}/E${i + 1}.mkv`,
      })),
    });
    const raw = JSON.stringify({
      name: 'Los Guardianes del Puerto', year: 2021, overview: 'x'.repeat(400), genres: ['Drama'],
      totalSeasons: 2, seasons: [season(1, 3), season(2, 7)],
      pagination: { page: 1, pageSize: 50, totalPages: 1, totalItems: 10 },
    });
    const compacted = compactToolResult('media_query', raw);
    expect(estimateTokenCount(compacted)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_CAP);
    const parsed = JSON.parse(compacted);
    expect(parsed.seasons[0].episodes[0]).toMatchObject({ name: 'Episodio 1', hasSubtitles: true });
    expect(parsed.seasons[1].episodes.at(-1)).toMatch(/^\[\+\d+ more\]$/);
  });

  it('activity_log: a bare array keeps who did what and its length', () => {
    const raw = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
      type: 'VideoPlayback', name: `marta reprodujo Plumas ${i}`, date: '2026-09-12T05:00', user: 'marta',
    })));
    const parsed = JSON.parse(compactToolResult('server_info', raw));
    expect(parsed.totalCount).toBe(12);
    expect(parsed.items[0]).toMatchObject({ user: 'marta', type: 'VideoPlayback' });
    expect(parsed.items.at(-1)).toBe('[+7 more]');
  });

  it('a very large nested result still fits the per-result cap as valid JSON', () => {
    const raw = JSON.stringify({
      name: 'Crónicas del Delta',
      seasons: Array.from({ length: 4 }, (_, s) => ({
        name: `Season ${s + 1}`, number: s + 1,
        episodes: Array.from({ length: 60 }, (_, e) => ({ id: `e${s}-${e}`, number: e + 1, name: `Remanso ${e + 1}`, path: '/data/tv/'.padEnd(110, 'p') })),
      })),
    });
    const compacted = compactToolResult('media_query', raw);
    expect(estimateTokenCount(compacted)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_CAP);
    expect(JSON.parse(compacted).name).toBe('Crónicas del Delta');
  });

  it('download_queue: keeps every source, its completeness and its paging within the cap', () => {
    const queue = (source: string) => ({
      source,
      records: Array.from({ length: 5 }, (_, i) => ({
        id: i, title: `Título largo de descarga ${source} ${i} `.repeat(3), status: 'downloading', progressPercent: 42.5,
      })),
      total: source === 'qbittorrent' ? null : 9,
      pagination: { page: 1, pageSize: 5, hasMore: true, nextPage: 2 },
    });
    const observedAt = '2026-09-12T12:00:00.000Z';
    const raw = JSON.stringify({
      status: 'partial',
      data: {
        queues: [
          queue('sonarr'),
          { source: 'radarr', records: null, total: null, pagination: { page: 1, pageSize: 5, hasMore: null, nextPage: null } },
          queue('qbittorrent'),
        ],
        note: 'Separate client queues may overlap. Null means unknown, not zero.',
      },
      sources: [
        { source: 'sonarr', completeness: 'complete', observedAt },
        { source: 'radarr', completeness: 'unavailable', observedAt, error: { code: 'ERR_UPSTREAM_UNAVAILABLE', message: 'radarr queue could not be read; its count and state are unknown.' } },
        { source: 'qbittorrent', completeness: 'complete', observedAt },
      ],
      page: { pageIndex: 1, pageSize: 5, totalItems: null, hasMore: true },
    });
    const compacted = compactToolResult('downloads', raw);
    expect(estimateTokenCount(compacted)).toBeLessThanOrEqual(TOOL_RESULT_TOKEN_CAP);
    const parsed = JSON.parse(compacted);
    expect(parsed.status).toBe('partial');
    expect(parsed.sources.map((s: any) => [s.source, s.completeness])).toEqual([
      ['sonarr', 'complete'], ['radarr', 'unavailable'], ['qbittorrent', 'complete'],
    ]);
    expect(parsed.data.queues.map((q: any) => q.source)).toEqual(['sonarr', 'radarr', 'qbittorrent']);
    expect(parsed.data.queues[1].records).toBeNull();
    expect(parsed.data.queues[0].records[0]).toMatchObject({ status: 'downloading', progressPercent: 42.5 });
    expect(parsed.data.queues[0].pagination).toMatchObject({ hasMore: true, nextPage: 2 });
  });

  it('summarizes observed references without listing every one', () => {
    const summary = buildStateSummary({
      ...createInitialWorkflowState('conv_1', 'p_1', 'inst_1'),
      intent: { kind: 'convert', summary: 'Convert Arrival' },
      references: {
        mediaRef: 'mref_000000000001',
        mediaRefs: ['mref_000000000001', 'mref_000000000002'],
        releaseRef: 'rref_000000000001',
        releaseRefs: ['rref_000000000001', 'rref_000000000002', 'rref_000000000003'],
        paths: ['media:a.mkv', 'media:b.mkv', 'media:c.mkv', 'media:d.mkv'],
        inspectedPaths: ['media:d.mkv'],
      },
    });
    expect(summary).toContain('mediaRefsSeen=2');
    expect(summary).toContain('releaseRefsSeen=3');
    expect(summary).toContain('listedFiles=4 [media:d.mkv | media:c.mkv | media:b.mkv]');
    expect(summary).toContain('analyzedFiles=[media:d.mkv]');
  });
});
