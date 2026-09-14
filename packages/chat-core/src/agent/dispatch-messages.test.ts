/* ─── What the model reads after a rejected or empty call ──────────────────
 * G10 experiment 4: "root must NOT have additional properties" made the model
 * repeat media_query(list, path) until the loop guard (STORAGE-01), and an empty
 * catalog search ended the turn although the title was in the library (READ-13).
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import { validateToolCall, dispatchToolCall, LIBRARY_MATCH_NOTE, NOTHING_FOUND_NOTE } from './dispatch.js';
import { compactToolResult } from './budget.js';
import type { VirtualToolDef } from '../types.js';

const tool = (name: string, properties: Record<string, unknown>, actions: string[]): VirtualToolDef => ({
  name,
  description: name,
  parameters: { type: 'object', properties: { action: { type: 'string', enum: actions }, ...properties }, required: ['action'] },
}) as VirtualToolDef;

const mediaQuery = tool('media_query', { query: { type: 'string' }, page: { type: 'integer' } }, ['search', 'list']);
const libraryOps = tool('library_ops', { path: { type: 'string' } }, ['list']);
const catalog = tool('catalog', { query: { type: 'string' }, type: { type: 'string' } }, ['search']);

describe('Validation errors name what to fix (AGT-01)', () => {
  it('names the unknown property first, the exposed tool that accepts it, then the allowed ones', () => {
    const res = validateToolCall('media_query', { action: 'list', path: '/data/tv/Serie Ñandú (2024)/Season 01' }, [mediaQuery, libraryOps]);
    expect(res.valid).toBe(false);
    expect(res.code).toBe('ERR_ARGS_INVALID');
    expect(res.error).toBe("Validation error for tool 'media_query': unknown property 'path' (library_ops accepts it); media_query accepts: action, query, page");
  });

  it('keeps the essential part within what compaction shows the model', () => {
    const res = validateToolCall('media_query', { action: 'list', path: '/x' }, [mediaQuery, libraryOps]);
    const payload = JSON.stringify({ status: 'error', error: { code: res.code, message: res.error } });
    expect(JSON.parse(compactToolResult('media_query', payload)).error.message).toContain('library_ops accepts it');
  });

  it('still rejects: the hint never widens the schema', () => {
    const res = validateToolCall('media_query', { action: 'list', bogus: 1 }, [mediaQuery, libraryOps]);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("unknown property 'bogus'; media_query accepts: action, query, page");
  });
});

describe('An empty catalog search is completed with a library search', () => {
  // Experiment 5: a hint alone ("search the library") made the model invent library
  // results (READ-13) or offer the search instead of running it (SEARCH-05).
  const complete = [{ source: 'radarr', completeness: 'complete' }];
  const empty = JSON.stringify({ schemaVersion: 1, status: 'ok', data: [], sources: complete });
  const found = JSON.stringify({ schemaVersion: 1, status: 'ok', data: [{ title: 'X', mediaRef: 'mref_000000000001' }], sources: complete });
  const colibri = { id: 'jf-movie-colibri', name: 'Ωmega: 秘密の庭 — La Última Canción del Colibrí Azul', type: 'Movie', year: 2022, path: '/data/movies/Colibri (2022)/Colibri (2022).mkv' };
  const calls: Array<[string, Record<string, unknown>]> = [];
  const run = (catalogResult: string, libraryResult: unknown, exposedTools: VirtualToolDef[], args: Record<string, unknown> = { action: 'search', query: 'colibrí azul' }) => {
    calls.length = 0;
    return dispatchToolCall({
      toolName: 'catalog',
      args,
      exposedTools,
      mcpCall: async (tool, toolArgs) => {
        calls.push([tool, toolArgs]);
        return tool === 'search_media' ? catalogResult : JSON.stringify(libraryResult);
      },
    });
  };

  it('adds the library matches and a note, both kept by compaction', async () => {
    const res = await run(empty, { total: 1, results: [colibri] }, [catalog, mediaQuery]);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([['search_media', { query: 'colibrí azul' }], ['jellyfin_search', { query: 'colibrí azul', pageSize: 5 }]]);
    const parsed = JSON.parse(res.result);
    expect(parsed.message).toBe(LIBRARY_MATCH_NOTE);
    expect(parsed.library).toEqual([{ id: colibri.id, name: colibri.name, type: 'Movie', year: 2022 }]);
    const compacted = JSON.parse(compactToolResult('catalog', res.result));
    expect(compacted.message).toBe(LIBRARY_MATCH_NOTE);
    expect(compacted.library[0]).toMatchObject({ id: colibri.id, type: 'Movie', year: 2022 });
  });

  it('says that nothing matched anywhere when the library has no match either', async () => {
    const res = await run(empty, { total: 0, results: [] }, [catalog, mediaQuery], { action: 'search', query: 'Zyxwvut Qqqq' });
    expect(JSON.parse(res.result)).toMatchObject({ message: NOTHING_FOUND_NOTE, library: [] });
  });

  it('searches the library with the year and type the catalog call carried', async () => {
    await run(empty, { total: 0, results: [] }, [catalog, mediaQuery], { action: 'search', query: 'Marea Alta (2012)', type: 'movie' });
    expect(calls[1]).toEqual(['jellyfin_search', { query: 'Marea Alta', type: 'Movie', year: 2012, pageSize: 5 }]);
  });

  it('names the sources that did not answer, and never reads a partial result as empty', async () => {
    const partial = JSON.stringify({ status: 'partial', data: [], sources: [...complete, { source: 'sonarr', completeness: 'unavailable' }] });
    const res = await run(partial, { total: 1, results: [colibri] }, [catalog, mediaQuery]);
    expect(calls.map(([tool]) => tool)).toEqual(['search_media']);
    expect(JSON.parse(res.result).message).toBe('Incomplete: sonarr did not answer, so its results are missing. Say so; do not call them absent.');
  });

  it('leaves results with items, catalogs without media_query and failed library reads unchanged', async () => {
    expect((await run(found, {}, [catalog, mediaQuery])).result).toBe(found);
    expect((await run(empty, {}, [catalog])).result).toBe(empty);
    expect((await run(empty, { isError: true, error: 'Jellyfin down' }, [catalog, mediaQuery])).result).toBe(empty);
  });
});
