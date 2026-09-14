/* ─── What the model reads after a rejected or empty call ──────────────────
 * G10 experiment 4: "root must NOT have additional properties" made the model
 * repeat media_query(list, path) until the loop guard (STORAGE-01), and an empty
 * catalog search ended the turn although the title was in the library (READ-13).
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import { validateToolCall, dispatchToolCall, EMPTY_CATALOG_HINT } from './dispatch.js';
import { compactToolResult } from './budget.js';
import type { VirtualToolDef } from '../types.js';

const tool = (name: string, properties: Record<string, unknown>, actions: string[]): VirtualToolDef => ({
  name,
  description: name,
  parameters: { type: 'object', properties: { action: { type: 'string', enum: actions }, ...properties }, required: ['action'] },
}) as VirtualToolDef;

const mediaQuery = tool('media_query', { query: { type: 'string' }, page: { type: 'integer' } }, ['search', 'list']);
const libraryOps = tool('library_ops', { path: { type: 'string' } }, ['list']);
const catalog = tool('catalog', { query: { type: 'string' } }, ['search']);

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

describe('An empty catalog search points to the library', () => {
  const empty = JSON.stringify({ schemaVersion: 1, status: 'ok', data: [], sources: [] });
  const found = JSON.stringify({ schemaVersion: 1, status: 'ok', data: [{ title: 'X', mediaRef: 'mref_000000000001' }], sources: [] });
  const run = (result: string, exposedTools: VirtualToolDef[]) =>
    dispatchToolCall({ toolName: 'catalog', args: { action: 'search', query: 'colibrí azul' }, exposedTools, mcpCall: async () => result });

  it('adds the hint in `message`, which compaction keeps, when media_query is exposed', async () => {
    const res = await run(empty, [catalog, mediaQuery]);
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.result).message).toBe(EMPTY_CATALOG_HINT);
    expect(JSON.parse(compactToolResult('catalog', res.result)).message).toBe(EMPTY_CATALOG_HINT);
  });

  it('leaves results with items, and catalogs without media_query, unchanged', async () => {
    expect((await run(found, [catalog, mediaQuery])).result).toBe(found);
    expect((await run(empty, [catalog])).result).toBe(empty);
  });
});
