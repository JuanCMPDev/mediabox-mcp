/* ─── Recovery from the calls and results small models got wrong ─────────────
 * G10 experiments 5 and 6 (qwen2.5:7b, qwen3.5:9b): an argument named `path` for
 * `paths` (STORAGE-02), a reference of the wrong kind (SEARCH-10, ADV-02), a title
 * wrapped in a type phrase (READ-13) and a call repeated to a service that was down
 * (SEARCH-10). Every case runs through dispatchToolCall with a fake MCP server, and
 * every note is checked after compaction, which is what the model reads.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import {
  dispatchToolCall,
  incompleteNote,
  normalizeTitleQuery,
  retryNote,
  retriedTitle,
  LIBRARY_MATCH_NOTE,
  NOTHING_FOUND_NOTE,
  UPSTREAM_UNAVAILABLE_NOTE,
} from './dispatch.js';
import { compactToolResult, TOOL_RESULT_STRING_CAP } from './budget.js';
import { computeArgsHash } from './guards.js';
import { getPhaseTools } from './phases.js';
import { FakeMcp } from './replay/fake-mcp.js';
import { normalizeResult } from '../mcp-client.js';
import { resolveVirtualCall, splitTitleYear } from '../tool-router.js';
import type { McpCallFn } from '../types.js';

const json = (value: unknown) => JSON.stringify(value);
/** FakeMcp answers `tool:{args}` keys, so each fixture pins the exact arguments. */
const key = (tool: string, args: Record<string, unknown>) => `${tool}:${JSON.stringify(args)}`;
const ledger = (mcp: FakeMcp) => mcp.ledger.map(({ tool, args }) => [tool, args]);

describe('library_ops propose_delete accepts `path` for `paths` (STORAGE-02, experiment 6)', () => {
  const listed = 'media:movies/Niebla de Marzo (2015)/Niebla de Marzo (2015).mkv';
  const references = { paths: [listed] };
  const tools = getPhaseTools('propose', { intentKind: 'delete', references });
  const plan = json({ planId: 'plan_1', operation: 'cleanup', status: 'awaiting_approval' });
  const propose = (args: Record<string, unknown>, mcp: FakeMcp) =>
    dispatchToolCall({ toolName: 'library_ops', args, exposedTools: tools, mcpCall: mcp.callFn, references });

  it('dispatches the listed path as paths and reports the effective args', async () => {
    const mcp = new FakeMcp({ propose_cleanup: plan });
    const args = { action: 'propose_delete', path: listed };
    const res = await propose(args, mcp);
    expect(res).toMatchObject({ ok: true, rejected: false, mcpTool: 'propose_cleanup' });
    expect(ledger(mcp)).toEqual([['propose_cleanup', { paths: [listed] }]]);
    // The runtime derives the proposal targets from the effective args.
    expect(res.args).toEqual({ action: 'propose_delete', paths: [listed] });
    // Loop detection still sees the call as the model wrote it.
    expect(res.argsHash).toBe(computeArgsHash(args));
  });

  it('still rejects a path the listing did not return', async () => {
    const mcp = new FakeMcp({ propose_cleanup: plan });
    const res = await propose({ action: 'propose_delete', path: 'media:movies/Eclipse (2019)/Eclipse (2019).mkv' }, mcp);
    expect(res).toMatchObject({ ok: false, rejected: true, errorCode: 'ERR_ARGS_INVALID' });
    expect(res.errorMessage).toContain('library_ops(action:"list")');
    expect(mcp.ledger).toEqual([]);
  });

  it('keeps `paths` when both are given, and never aliases an empty path', async () => {
    const both = new FakeMcp({ propose_cleanup: plan });
    const res = await propose({ action: 'propose_delete', paths: [listed], path: 'media:movies/Eclipse (2019)/Eclipse (2019).mkv' }, both);
    expect(ledger(both)).toEqual([['propose_cleanup', { paths: [listed] }]]);
    expect(res.args?.paths).toEqual([listed]);

    const blank = new FakeMcp({ propose_cleanup: plan });
    expect(await propose({ action: 'propose_delete', path: '   ' }, blank)).toMatchObject({ ok: false, rejected: true });
    expect(blank.ledger).toEqual([]);
  });

  it('leaves `path` alone for every other action', async () => {
    const mcp = new FakeMcp({ manage_files: json({ status: 'ok', data: [] }) });
    const folder = 'media:movies/Niebla de Marzo (2015)';
    const res = await propose({ action: 'list', path: folder }, mcp);
    expect(res.args).toEqual({ action: 'list', path: folder });
    expect(ledger(mcp)).toEqual([['manage_files', { action: 'list', path: folder }]]);
  });
});

describe('Catalog references of the wrong kind never reach the server (SEARCH-10, ADV-02, experiment 5)', () => {
  const readTools = getPhaseTools('select', { intentKind: 'download' });
  const references = { releaseRef: 'rref_000000000001', mediaRef: 'mref_000000000001' };
  const proposeTools = getPhaseTools('propose', { intentKind: 'download', references });

  it.each([
    ['details', 'jf-series-guard', "mediaRef 'jf-series-guard' is not a catalog reference"],
    ['releases', 'jf-series-guard', "mediaRef 'jf-series-guard' is not a catalog reference"],
    ['details', 'rref_7f3a9c2e1b4d', "mediaRef 'rref_7f3a9c2e1b4d' is a releaseRef"],
  ])('%s with mediaRef %s fails before dispatch and is not a schema repair', async (action, mediaRef, says) => {
    const mcp = new FakeMcp();
    const res = await dispatchToolCall({ toolName: 'catalog', args: { action, mediaRef }, exposedTools: readTools, mcpCall: mcp.callFn });
    // rejected:false is what keeps ERR_REPAIR_EXHAUSTED from firing in the runtime.
    expect(res).toMatchObject({ ok: false, rejected: false, errorCode: 'ERR_REF_INVALID' });
    expect(res.errorMessage).toContain(says);
    expect(res.errorMessage).toContain('mediaRef (mref_...) of a catalog(action:"search") result');
    expect(mcp.ledger).toEqual([]);
    const compacted = JSON.parse(compactToolResult('catalog', res.result));
    expect(compacted.error).toEqual({ code: 'ERR_REF_INVALID', message: res.errorMessage });
  });

  it('names a mediaRef given as releaseRef in a proposal, and never sends it', async () => {
    const mcp = new FakeMcp();
    const res = await dispatchToolCall({
      toolName: 'catalog', args: { action: 'propose_download', releaseRef: 'mref_000000000001' },
      exposedTools: proposeTools, mcpCall: mcp.callFn, references,
    });
    expect(res).toMatchObject({ ok: false, rejected: false, errorCode: 'ERR_REF_INVALID' });
    expect(res.errorMessage).toContain("releaseRef 'mref_000000000001' is a mediaRef");
    expect(res.errorMessage).toContain('catalog(action:"releases")');
    expect(mcp.ledger).toEqual([]);
  });

  it('leaves well-formed references to grounding and to the server', async () => {
    const unobserved = new FakeMcp();
    const res = await dispatchToolCall({
      toolName: 'catalog', args: { action: 'propose_download', releaseRef: 'rref_00000000beef' },
      exposedTools: proposeTools, mcpCall: unobserved.callFn, references,
    });
    expect(res).toMatchObject({ ok: false, rejected: true, errorCode: 'ERR_ARGS_INVALID' });
    expect(unobserved.ledger).toEqual([]);

    const mcp = new FakeMcp({ media_details: json({ status: 'ok', data: { title: 'Niebla de Marzo', year: 2015, mediaRef: 'mref_000000000001' } }) });
    const read = await dispatchToolCall({ toolName: 'catalog', args: { action: 'details', mediaRef: 'mref_000000000001' }, exposedTools: readTools, mcpCall: mcp.callFn });
    expect(read.ok).toBe(true);
    expect(ledger(mcp)).toEqual([['media_details', { mediaRef: 'mref_000000000001' }]]);
  });

  it('keeps two reference errors within the 300-character error cap', async () => {
    const mcp = new FakeMcp();
    const res = await dispatchToolCall({
      toolName: 'catalog', args: { action: 'propose_download', releaseRef: `x${'ñ'.repeat(300)}`, mediaRef: `y${'🎬'.repeat(150)}` },
      exposedTools: proposeTools, mcpCall: mcp.callFn, references,
    });
    expect(res.errorCode).toBe('ERR_REF_INVALID');
    expect(res.errorMessage!.length).toBeLessThanOrEqual(300);
    expect(res.errorMessage).toContain('is not a release reference');
    expect(res.errorMessage).toContain('is not a catalog reference');
    // Compaction keeps the whole message: nothing is cut.
    expect(JSON.parse(compactToolResult('catalog', res.result)).error.message).toBe(res.errorMessage);
  });
});

describe('normalizeTitleQuery', () => {
  it.each([
    ['película del colibrí azul', 'colibrí azul'],
    ['la serie Marea Alta', 'Marea Alta'],
    ['the movie Arrival', 'Arrival'],
    ['la película El Hobbit', 'El Hobbit'],
    ['Pelicula de la Tierra Media', 'Tierra Media'],
    ['documentales de ballenas', 'ballenas'],
    ['a film called Arrival', 'Arrival'],
    ['"Marea Alta"', 'Marea Alta'],
    ['la película «El Hobbit»', 'El Hobbit'],
    // Review finding D1: a capitalized article after "de" is the title's own.
    ['la serie de Los Guardianes del Puerto', 'Los Guardianes del Puerto'],
    ['the movie of The Rings', 'The Rings'],
    // The documented trade-off: a lowercase article after "de" belongs to the phrase.
    ['película de las estrellas', 'estrellas'],
    // D1: a quoted title keeps its year, and a separator after the type word goes.
    ['"Eclipse" (2017)', 'Eclipse (2017)'],
    // F5: a quoted title followed by a bare year keeps the year in the form splitTitleYear splits.
    ['«Eclipse» 2017', 'Eclipse (2017)'],
    ['"Eclipse" 2017', 'Eclipse (2017)'],
    ['película "Eclipse"', 'Eclipse'],
    ['película "Eclipse" (2017)', 'Eclipse (2017)'],
    ["'Ocean's Eleven' (2001)", "Ocean's Eleven (2001)"],
    ['película: Eclipse', 'Eclipse'],
    ['película - Eclipse', 'Eclipse'],
    ['la película: Eclipse', 'Eclipse'],
    // F5: trailing sentence punctuation no longer defeats the quote handling.
    ['"Eclipse" (2017).', 'Eclipse (2017)'],
    ['Película "Eclipse", de 2017', 'Eclipse (2017)'],
    ['la película Eclipse.', 'Eclipse'],
    ['"Blade Runner 2049"', 'Blade Runner 2049'],
  ])('%s → %s', (query, title) => expect(normalizeTitleQuery(query)).toBe(title));

  it.each([
    ['Marea Alta'], ['El Señor de los Anillos'], ['la película'], [''], ['   '],
    // D1: a bare type word may be the title's own first word.
    ['Serie Ñandú'], ['Movie 43'], ['Show Me Love'], ['Showtime'], ['Eclipse (2017)'],
    // F5: a bare year after an unquoted title stays, and punctuation alone is no new query.
    ['Blade Runner 2049'], ['Airplane!'],
    // F5: unbalanced quotes leave the query as it is instead of stripping one side.
    ['"Eclipse'], ['película "Eclipse'], ['Eclipse"'], ['"Eclipse" y más'],
  ])('%s → undefined', query => {
    expect(normalizeTitleQuery(query)).toBeUndefined();
  });

  it('gives splitTitleYear a title and year it can split (D1)', () => {
    expect(splitTitleYear(normalizeTitleQuery('"Eclipse" (2017)'), undefined)).toEqual({ query: 'Eclipse', year: 2017 });
    expect(splitTitleYear(normalizeTitleQuery('la película "Eclipse" (2017)'), undefined)).toEqual({ query: 'Eclipse', year: 2017 });
  });

  it.each([
    ['"Eclipse" (2017)', { query: 'Eclipse', year: 2017 }],
    ['la película "Eclipse" (2017)', { query: 'Eclipse', year: 2017 }],
    ['«Eclipse» 2017', { query: 'Eclipse', year: 2017 }],
    ['"Eclipse" 2017', { query: 'Eclipse', year: 2017 }],
    ['"Eclipse" (2017).', { query: 'Eclipse', year: 2017 }],
    ['Película "Eclipse", de 2017', { query: 'Eclipse', year: 2017 }],
    ['"Blade Runner 2049"', { query: 'Blade Runner 2049' }],
  ])('routes the normalized %s to the catalog search as title and year (F5)', (query, routed) => {
    expect(resolveVirtualCall('catalog', { action: 'search', query: normalizeTitleQuery(query) })).toEqual({ tool: 'search_media', args: routed });
  });

  it('routes an unquoted "Blade Runner 2049" as the model wrote it (F5)', () => {
    expect(normalizeTitleQuery('Blade Runner 2049')).toBeUndefined();
    expect(resolveVirtualCall('catalog', { action: 'search', query: 'Blade Runner 2049' }).args).toEqual({ query: 'Blade Runner 2049' });
  });

  it('names the title a result answers only for the retry note of its own query (F3)', () => {
    expect(normalizeTitleQuery('El Show de Truman')).toBe('Truman');
    expect(retriedTitle('El Show de Truman', retryNote('El Show de Truman', 'Truman'))).toBe('Truman');
    expect(retriedTitle('El Show de Truman', undefined)).toBeUndefined();
    expect(retriedTitle('El Show de Truman', 'No match for something else.')).toBeUndefined();
    expect(retriedTitle('Eclipse', retryNote('Eclipse', 'Eclipse'))).toBeUndefined();
  });

  it('ignores anything that is not a string', () => {
    expect(normalizeTitleQuery(undefined)).toBeUndefined();
    expect(normalizeTitleQuery(42)).toBeUndefined();
  });
});

describe('An empty search is repeated once with the title alone (READ-13, experiments 5 and 6)', () => {
  const complete = [{ source: 'radarr', completeness: 'complete' }, { source: 'sonarr', completeness: 'complete' }];
  const empty = json({ schemaVersion: 1, status: 'ok', data: [], sources: complete });
  // The READ-13 title only exists in the library; Jellyfin matches a folded substring of Name.
  const colibriName = 'Ωmega: 秘密の庭 — La Última Canción del Colibrí Azul que Cantaba en Noches de Tormenta Sobre Valparaíso (Edición Extendida del Director) 🎬';
  const colibri = { id: 'jf-movie-colibri', name: colibriName, type: 'Movie', year: 2022, series: null, path: '/data/movies/Colibri (2022)/Colibri (2022).mkv', episode: null };
  const jellyfin = (results: unknown[]) => json({
    total: results.length, results,
    pagination: { page: 1, pageSize: 50, totalPages: results.length ? 1 : 0, totalItems: results.length, hasMore: false },
  });
  const searchTools = getPhaseTools('orient', { intentKind: 'other' });
  const libraryTools = getPhaseTools('orient', { intentKind: 'library' });
  const search = (toolName: string, args: Record<string, unknown>, mcp: FakeMcp) =>
    dispatchToolCall({ toolName, args, exposedTools: toolName === 'catalog' ? searchTools : libraryTools, mcpCall: mcp.callFn });

  it('answers READ-13 from the library with the normalized title, in two extra calls', async () => {
    const mcp = new FakeMcp({
      [key('search_media', { query: 'película del colibrí azul' })]: empty,
      [key('search_media', { query: 'colibrí azul' })]: empty,
      [key('jellyfin_search', { query: 'colibrí azul', pageSize: 5 })]: jellyfin([colibri]),
    });
    const res = await search('catalog', { action: 'search', query: 'película del colibrí azul' }, mcp);
    expect(mcp.unexpectedCalls).toEqual([]);
    // The first call goes as the model wrote it; READ-13's oracle needs the audited reads.
    expect(mcp.ledger.map(e => e.tool)).toEqual(['search_media', 'search_media', 'jellyfin_search']);
    const compacted = JSON.parse(compactToolResult('catalog', res.result));
    expect(compacted.message).toBe(LIBRARY_MATCH_NOTE);
    expect(compacted.library[0]).toMatchObject({ id: colibri.id, type: 'Movie', year: 2022 });
    expect(compacted.library[0].name).toContain('Colibrí Azul');
  });

  it('returns the catalog results of the normalized title with a note that says so', async () => {
    const found = json({ schemaVersion: 1, status: 'ok', data: [{ title: 'Colibrí Azul', year: 2022, mediaRef: 'mref_000000000042' }], sources: complete });
    const mcp = new FakeMcp({
      [key('search_media', { query: 'película del colibrí azul' })]: empty,
      [key('search_media', { query: 'colibrí azul' })]: found,
    });
    const res = await search('catalog', { action: 'search', query: 'película del colibrí azul' }, mcp);
    expect(mcp.unexpectedCalls).toEqual([]);
    expect(mcp.ledger).toHaveLength(2);
    const note = 'No match for "película del colibrí azul"; these results are for "colibrí azul".';
    expect(retryNote('película del colibrí azul', 'colibrí azul')).toBe(note);
    const compacted = JSON.parse(compactToolResult('catalog', res.result));
    expect(compacted.message).toBe(note);
    expect(compacted.data[0]).toMatchObject({ title: 'Colibrí Azul', mediaRef: 'mref_000000000042' });
  });

  it('keeps the year and type handling of the first call', async () => {
    const mcp = new FakeMcp({
      [key('search_media', { query: 'la película Marea Alta', type: 'movie', year: 2012 })]: empty,
      [key('search_media', { query: 'Marea Alta', type: 'movie', year: 2012 })]: empty,
      [key('jellyfin_search', { query: 'Marea Alta', type: 'Movie', year: 2012, pageSize: 5 })]: jellyfin([]),
    });
    const res = await search('catalog', { action: 'search', query: 'la película Marea Alta (2012)', type: 'movie' }, mcp);
    expect(mcp.unexpectedCalls).toEqual([]);
    expect(mcp.ledger).toHaveLength(3);
    expect(JSON.parse(res.result)).toMatchObject({ message: NOTHING_FOUND_NOTE, library: [] });
  });

  it('retries a quoted title with a bare year and a final period as title and year (F5)', async () => {
    const found = json({ schemaVersion: 1, status: 'ok', data: [{ title: 'Eclipse', year: 2017, mediaRef: 'mref_000000002017' }], sources: complete });
    const mcp = new FakeMcp({
      [key('search_media', { query: '«Eclipse» 2017.' })]: empty,
      [key('search_media', { query: 'Eclipse', year: 2017 })]: found,
    });
    const res = await search('catalog', { action: 'search', query: '«Eclipse» 2017.' }, mcp);
    expect(mcp.unexpectedCalls).toEqual([]);
    expect(ledger(mcp)).toEqual([['search_media', { query: '«Eclipse» 2017.' }], ['search_media', { query: 'Eclipse', year: 2017 }]]);
    expect(JSON.parse(res.result).message).toBe(retryNote('«Eclipse» 2017.', 'Eclipse (2017)'));
  });

  it('never searches a plain title twice', async () => {
    const mcp = new FakeMcp({
      [key('search_media', { query: 'Zyxwvut Qqqq' })]: empty,
      [key('jellyfin_search', { query: 'Zyxwvut Qqqq', pageSize: 5 })]: jellyfin([]),
    });
    await search('catalog', { action: 'search', query: 'Zyxwvut Qqqq' }, mcp);
    expect(mcp.ledger.map(e => e.tool)).toEqual(['search_media', 'jellyfin_search']);
  });

  it('falls back to the library when the retry fails', async () => {
    const down = json({ status: 'error', data: null, error: { code: 'ERR_UPSTREAM_UNAVAILABLE', message: 'A service could not be reached.' }, isError: true });
    const mcp = new FakeMcp({
      [key('search_media', { query: 'película del colibrí azul' })]: empty,
      [key('search_media', { query: 'colibrí azul' })]: down,
      [key('jellyfin_search', { query: 'colibrí azul', pageSize: 5 })]: jellyfin([colibri]),
    });
    const res = await search('catalog', { action: 'search', query: 'película del colibrí azul' }, mcp);
    expect(mcp.ledger).toHaveLength(3);
    expect(JSON.parse(res.result).message).toBe(LIBRARY_MATCH_NOTE);
  });

  it('repeats an empty media_query search once with the normalized title', async () => {
    const mcp = new FakeMcp({
      [key('jellyfin_search', { query: 'película del colibrí azul' })]: jellyfin([]),
      [key('jellyfin_search', { query: 'colibrí azul' })]: jellyfin([colibri]),
    });
    const res = await search('media_query', { action: 'search', query: 'película del colibrí azul' }, mcp);
    expect(mcp.unexpectedCalls).toEqual([]);
    expect(mcp.ledger).toHaveLength(2);
    const compacted = JSON.parse(compactToolResult('media_query', res.result));
    expect(compacted.message).toBe(retryNote('película del colibrí azul', 'colibrí azul'));
    expect(compacted.results[0]).toMatchObject({ id: colibri.id, type: 'Movie', year: 2022 });
    expect(compacted.total).toBe(1);
  });

  it('leaves a media_query search alone when it found something or the retry finds nothing', async () => {
    const foundFirst = new FakeMcp({ [key('jellyfin_search', { query: 'la película Colibrí' })]: jellyfin([colibri]) });
    const first = await search('media_query', { action: 'search', query: 'la película Colibrí' }, foundFirst);
    expect(foundFirst.ledger).toHaveLength(1);
    expect(JSON.parse(first.result).message).toBeUndefined();

    const nothing = new FakeMcp({
      [key('jellyfin_search', { query: 'la serie Zyxwvut' })]: jellyfin([]),
      [key('jellyfin_search', { query: 'Zyxwvut' })]: jellyfin([]),
    });
    const res = await search('media_query', { action: 'search', query: 'la serie Zyxwvut' }, nothing);
    expect(nothing.ledger).toHaveLength(2);
    expect(res.result).toBe(jellyfin([]));
  });

  describe('a retry with incomplete sources says which source did not answer (D2)', () => {
    const halfDown = [{ source: 'radarr', completeness: 'complete' }, { source: 'sonarr', completeness: 'unavailable' }];
    const sonarrDown = incompleteNote(['sonarr']);

    it('with items, carries incompleteNote instead of the retry note', async () => {
      const partial = json({ schemaVersion: 1, status: 'partial', data: [{ title: 'Colibrí Azul', year: 2022, mediaRef: 'mref_000000000042' }], sources: halfDown });
      const mcp = new FakeMcp({
        [key('search_media', { query: 'película del colibrí azul' })]: empty,
        [key('search_media', { query: 'colibrí azul' })]: partial,
      });
      const res = await search('catalog', { action: 'search', query: 'película del colibrí azul' }, mcp);
      expect(mcp.unexpectedCalls).toEqual([]);
      expect(mcp.ledger).toHaveLength(2);
      const compacted = JSON.parse(compactToolResult('catalog', res.result));
      expect(compacted.message).toBe(sonarrDown);
      expect(compacted.data[0]).toMatchObject({ title: 'Colibrí Azul', mediaRef: 'mref_000000000042' });
    });

    it('without items, keeps library matches but never says "no match" for the title', async () => {
      const partialEmpty = json({ schemaVersion: 1, status: 'partial', data: [], sources: halfDown });
      const nothing = new FakeMcp({
        [key('search_media', { query: 'película del colibrí azul' })]: empty,
        [key('search_media', { query: 'colibrí azul' })]: partialEmpty,
        [key('jellyfin_search', { query: 'colibrí azul', pageSize: 5 })]: jellyfin([]),
      });
      const res = await search('catalog', { action: 'search', query: 'película del colibrí azul' }, nothing);
      expect(nothing.unexpectedCalls).toEqual([]);
      expect(JSON.parse(compactToolResult('catalog', res.result))).toMatchObject({ message: sonarrDown, library: [] });

      const found = new FakeMcp({
        [key('search_media', { query: 'película del colibrí azul' })]: empty,
        [key('search_media', { query: 'colibrí azul' })]: partialEmpty,
        [key('jellyfin_search', { query: 'colibrí azul', pageSize: 5 })]: jellyfin([colibri]),
      });
      const withLibrary = await search('catalog', { action: 'search', query: 'película del colibrí azul' }, found);
      expect(JSON.parse(withLibrary.result).message).toBe(LIBRARY_MATCH_NOTE);
    });

    it('without items and without media_query, still names the source', async () => {
      const mcp = new FakeMcp({
        [key('search_media', { query: 'película del colibrí azul' })]: empty,
        [key('search_media', { query: 'colibrí azul' })]: json({ status: 'partial', data: [], sources: halfDown }),
      });
      const res = await dispatchToolCall({
        toolName: 'catalog', args: { action: 'search', query: 'película del colibrí azul' },
        exposedTools: searchTools.filter(t => t.name !== 'media_query'), mcpCall: mcp.callFn,
      });
      expect(mcp.ledger.map(e => e.tool)).toEqual(['search_media', 'search_media']);
      expect(JSON.parse(res.result)).toMatchObject({ message: sonarrDown, data: [] });
    });
  });

  it('keeps every retry note within the message cap', () => {
    expect(retryNote('x'.repeat(300), `${'🎬'.repeat(100)}`).length).toBeLessThanOrEqual(TOOL_RESULT_STRING_CAP);
    expect(retryNote(`la película ${colibriName}`, colibriName).length).toBeLessThanOrEqual(TOOL_RESULT_STRING_CAP);
  });
});

describe('A source that did not answer is not asked again in the same turn (SEARCH-10, experiment 6)', () => {
  const searchTools = getPhaseTools('orient', { intentKind: 'other' });
  const searchWith = (mcpCall: McpCallFn) =>
    dispatchToolCall({ toolName: 'catalog', args: { action: 'search', query: 'Serie Ñandú' }, exposedTools: searchTools, mcpCall });

  it('adds do-not-repeat to the partial note, and compaction keeps it whole', async () => {
    const partial = json({ status: 'partial', data: [], sources: [{ source: 'radarr', completeness: 'complete' }, { source: 'sonarr', completeness: 'unavailable' }] });
    const mcp = new FakeMcp({ search_media: partial });
    const res = await searchWith(mcp.callFn);
    const note = 'Incomplete: sonarr did not answer. Say so; do not call its results absent. Do not repeat the call in this turn.';
    expect(JSON.parse(res.result).message).toBe(note);
    expect(JSON.parse(compactToolResult('catalog', res.result)).message).toBe(note);
    expect(mcp.ledger).toHaveLength(1);
  });

  it('keeps realistic source lists within the message cap', () => {
    for (const names of [['sonarr'], ['radarr'], ['qbittorrent'], ['sonarr', 'radarr'], ['radarr', 'qbittorrent'], ['sonarr', 'radarr', 'qbittorrent']]) {
      const note = incompleteNote(names);
      expect(note.length, names.join(',')).toBeLessThanOrEqual(TOOL_RESULT_STRING_CAP);
      expect(note).toContain('Do not repeat the call in this turn.');
    }
    expect(incompleteNote(['sonarr', 'radarr'])).toContain('sonarr, radarr did not answer');
    expect(incompleteNote(['sonarr', 'radarr', 'qbittorrent'])).toContain('3 sources did not answer');
  });

  it('tells the model not to repeat a call whose service is unavailable, keeping the error', async () => {
    const error = { code: 'ERR_UPSTREAM_UNAVAILABLE', message: 'Sonarr answered HTTP 503 and is unavailable; its response body is withheld.', retryable: true };
    const envelope = { schemaVersion: 1, requestId: 'req_1', status: 'error', data: null, sources: [], error };
    // The shape mcp-client gives an MCP isError result.
    const mcp = new FakeMcp({ search_media: normalizeResult('search_media', { isError: true, content: [{ type: 'text', text: json(envelope) }] }) });
    const res = await searchWith(mcp.callFn);
    expect(res).toMatchObject({ ok: false, rejected: false });
    const parsed = JSON.parse(res.result);
    expect(parsed.message).toBe(UPSTREAM_UNAVAILABLE_NOTE);
    expect(parsed.error).toEqual(error);
    expect(UPSTREAM_UNAVAILABLE_NOTE.length).toBeLessThanOrEqual(TOOL_RESULT_STRING_CAP);
    const compacted = JSON.parse(compactToolResult('catalog', res.result));
    expect(compacted.message).toBe(UPSTREAM_UNAVAILABLE_NOTE);
    expect(compacted.error.code).toBe('ERR_UPSTREAM_UNAVAILABLE');
  });

  it('annotates a thrown upstream failure the same way', async () => {
    const res = await searchWith(async () => {
      throw Object.assign(new Error('A service could not be reached.'), { code: 'ERR_UPSTREAM_UNAVAILABLE' });
    });
    expect(res).toMatchObject({ ok: false, rejected: false, errorCode: 'ERR_UPSTREAM_UNAVAILABLE' });
    expect(JSON.parse(res.result).message).toBe(UPSTREAM_UNAVAILABLE_NOTE);
  });

  it('leaves other failures and validation rejections without the note', async () => {
    for (const code of ['ERR_UPSTREAM_REJECTED', 'ERR_UPSTREAM_TIMEOUT', 'ERR_PATH_NOT_FOUND']) {
      const mcp = new FakeMcp({ search_media: json({ status: 'error', data: null, error: { code, message: 'x' }, isError: true }) });
      const res = await searchWith(mcp.callFn);
      expect(res.ok, code).toBe(false);
      expect(JSON.parse(res.result).message, code).toBeUndefined();
    }
    const rejected = await dispatchToolCall({
      toolName: 'catalog', args: { action: 'search', query: 'x', bogus: 1 }, exposedTools: searchTools, mcpCall: new FakeMcp().callFn,
    });
    expect(rejected.rejected).toBe(true);
    expect(JSON.parse(rejected.result).message).toBeUndefined();
  });
});
