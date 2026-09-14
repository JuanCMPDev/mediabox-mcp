/* ─── MCP error results reach the model with their code and message ─────────
 * An error envelope used to be wrapped as a string and cut at 120 characters,
 * before its code and message: in G10 experiment 4 the model saw only
 * "status: error" for a download already in the Radarr queue (DOWNLOAD-05).
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import { normalizeResult } from './mcp-client.js';
import { compactToolResult } from './agent/budget.js';

const DUPLICATE = JSON.stringify({
  schemaVersion: 1,
  requestId: 'req_1e07758f-efd4-43ec-ba08-6acb1087e723',
  status: 'error',
  data: null,
  sources: [],
  error: {
    code: 'ERR_DUPLICATE_DOWNLOAD',
    message: 'Release "Rio.Quieto.2021.1080p.WEB-DL.LATINO.x264-SYN" is already in the radarr queue (queue id 701)',
    retryable: false,
  },
});

const errorResult = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

describe('MCP error results', () => {
  it('keep an error envelope as an object, so compaction keeps its code and message', () => {
    const text = normalizeResult('propose_download', errorResult(DUPLICATE));
    const parsed = JSON.parse(text);
    expect(parsed.isError).toBe(true);
    expect(parsed.error.code).toBe('ERR_DUPLICATE_DOWNLOAD');

    const compacted = JSON.parse(compactToolResult('catalog', text));
    expect(compacted.status).toBe('error');
    expect(compacted.error).toMatchObject({
      code: 'ERR_DUPLICATE_DOWNLOAD',
      message: expect.stringContaining('already in the radarr queue (queue id 701)'),
    });
  });

  it('wrap plain error text as before', () => {
    const text = normalizeResult('operation_status', errorResult("Operation plan 'x' not found."));
    expect(JSON.parse(text)).toEqual({ isError: true, error: "Operation plan 'x' not found." });
  });

  it('give an error message more room than a data string, still bounded', () => {
    const long = JSON.stringify({ status: 'error', error: { code: 'ERR_X', message: 'y'.repeat(500) } });
    const compacted = JSON.parse(compactToolResult('catalog', normalizeResult('t', errorResult(long))));
    expect(compacted.error.message).toHaveLength(303);
  });
});
