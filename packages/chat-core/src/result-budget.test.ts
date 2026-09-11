import { describe, expect, it } from 'vitest';
import {
  boundToolResultText,
  detectToolFailure,
  extractToolFailureMessage,
  cutToBytes,
  safeSlice,
  DEFAULT_RESULT_BUDGET_BYTES,
} from './result-budget.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('boundToolResultText', () => {
  it('returns results within the budget untouched', () => {
    const text = JSON.stringify({ title: 'Trial and Error 😀', notes: 'x'.repeat(1_000) });
    expect(boundToolResultText(text)).toBe(text);
    expect(boundToolResultText('plain text with émojis 😀')).toBe('plain text with émojis 😀');
  });

  it('bounds a huge JSON object with surrogate pairs to 24,000 bytes of valid JSON', () => {
    const doc = {
      title: '🎬 Trial and Error 😀',
      // 300k+ code units; the 400-unit cut lands on the high half of a surrogate pair
      big: 'a' + '😀'.repeat(150_000),
      items: Array.from({ length: 500 }, (_, i) => ({ i, name: `item ${i} 😀`, tags: ['a', 'b'] })),
      nested: { deep: { deeper: { text: 'é😀'.repeat(5_000) } } },
    };
    const source = JSON.stringify(doc);
    expect(bytes(source)).toBeGreaterThan(300_000);

    const out = boundToolResultText(source);

    expect(bytes(out)).toBeLessThanOrEqual(DEFAULT_RESULT_BUDGET_BYTES);
    expect(LONE_SURROGATE.test(out)).toBe(false);
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed.title).toBe('🎬 Trial and Error 😀');
    expect(parsed.big.endsWith('…')).toBe(true);
    expect(parsed.big.length).toBeLessThanOrEqual(401);
    expect(LONE_SURROGATE.test(parsed.big)).toBe(false);
    expect(parsed.items.length).toBeLessThanOrEqual(51);
    expect(parsed.items[0]).toEqual({ i: 0, name: 'item 0 😀', tags: ['a', 'b'] });
    expect(typeof parsed.items[parsed.items.length - 1]).toBe('string'); // "…(N more items truncated)"
    expect(parsed.nested.deep.deeper.text.endsWith('…')).toBe(true);
  });

  it('prunes a top-level array and appends a truncation marker object', () => {
    const arr = Array.from({ length: 2_000 }, (_, i) => ({ id: i, title: `Release ${i} ` + 'x'.repeat(600) }));
    const out = boundToolResultText(JSON.stringify(arr));

    expect(bytes(out)).toBeLessThanOrEqual(DEFAULT_RESULT_BUDGET_BYTES);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[parsed.length - 1]).toEqual({ _truncated: true });
    expect(parsed[0].id).toBe(0);
    expect(parsed[0].title.length).toBeLessThanOrEqual(401);
  });

  it('keeps pathological shapes (thousands of keys, very deep nesting) valid and within budget', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 5_000; i++) wide[`key${i}`] = `value${i}`;
    const wideOut = boundToolResultText(JSON.stringify(wide));
    expect(bytes(wideOut)).toBeLessThanOrEqual(DEFAULT_RESULT_BUDGET_BYTES);
    expect(JSON.parse(wideOut)._truncated).toBe(true);

    let deep: unknown = 'leaf';
    for (let i = 0; i < 300; i++) deep = { child: deep, pad: 'p'.repeat(200) };
    const deepOut = boundToolResultText(JSON.stringify(deep));
    expect(bytes(deepOut)).toBeLessThanOrEqual(DEFAULT_RESULT_BUDGET_BYTES);
    expect(JSON.parse(deepOut)._truncated).toBe(true);
  });

  it('honours a custom byte budget', () => {
    const doc = { list: Array.from({ length: 300 }, (_, i) => `entry-${i}-` + 'y'.repeat(100)) };
    const out = boundToolResultText(JSON.stringify(doc), 2_000);
    expect(bytes(out)).toBeLessThanOrEqual(2_000);
    expect(JSON.parse(out)._truncated).toBe(true);
  });

  it('wraps a primitive JSON value that must be cut', () => {
    const out = boundToolResultText(JSON.stringify('😀'.repeat(10_000)), 500);
    expect(bytes(out)).toBeLessThanOrEqual(500);
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    expect(typeof parsed.value).toBe('string');
    expect(LONE_SURROGATE.test(parsed.value)).toBe(false);
  });

  it('keeps error envelopes detectable after pruning', () => {
    const envelope = JSON.stringify({ status: 'error', data: [], error: { code: 'UPSTREAM', message: 'boom '.repeat(2_000) } });
    const out = boundToolResultText(envelope, 1_000);
    expect(bytes(out)).toBeLessThanOrEqual(1_000);
    expect(detectToolFailure(out)).toBe(true);
    expect(JSON.parse(out)._truncated).toBe(true);
  });

  it('cuts non-JSON text on a safe boundary and appends a truncation marker', () => {
    const text = 'log: ' + '😀'.repeat(20_000);
    const out = boundToolResultText(text, 1_000);
    expect(bytes(out)).toBeLessThanOrEqual(1_000);
    expect(bytes(out)).toBeGreaterThan(990); // does not over-truncate
    expect(out.endsWith('\n…(truncated)')).toBe(true);
    expect(out.startsWith('log: 😀')).toBe(true);
    expect(LONE_SURROGATE.test(out)).toBe(false);
  });

  it('never splits surrogate pairs in the low-level helpers', () => {
    expect(safeSlice('a😀', 2)).toBe('a');
    expect(safeSlice('😀😀', 3)).toBe('😀');
    expect(safeSlice('😀😀', 4)).toBe('😀😀');
    expect(safeSlice('ab', 5)).toBe('ab');
    expect(cutToBytes('a😀', 4)).toBe('a');
    expect(cutToBytes('a😀', 5)).toBe('a😀');
    expect(cutToBytes('é', 1)).toBe('');
    expect(cutToBytes('éa', 3)).toBe('éa');
  });
});

describe('detectToolFailure', () => {
  it.each([
    ['MCP isError wrapper', '{"isError":true,"error":"Operation plan not found."}'],
    ['envelope status error', '{"schemaVersion":1,"status":"error","data":null,"sources":[],"error":{"code":"X","message":"y"}}'],
    ['plain error string', '{"error":"Item not found"}'],
    ['contained mutation', '{"error":"OPERATION_MUTATION_CONTAINED","code":"SEC-03","status":"blocked"}'],
    ['error object with code only', '{"error":{"code":"E_TIMEOUT"}}'],
    ['error object with message only', '{"error":{"message":"boom"}}'],
    ['pretty-printed envelope', '{\n  "status": "error",\n  "error": { "code": "A", "message": "b" }\n}'],
  ])('flags %s as a failure', (_label, result) => {
    expect(detectToolFailure(result)).toBe(true);
  });

  it.each([
    ['an array whose title contains the word error', '[{"title":"Trial and Error"}]'],
    ['a nested error key inside data', '{"status":"ok","data":[{"title":"Trial and Error","error":"not top-level"}]}'],
    ['a nested object with error', '{"results":{"error":"deep"}}'],
    ['status ok with null error', '{"status":"ok","error":null}'],
    ['a partial envelope', '{"status":"partial","data":[],"warnings":["Radarr unavailable"]}'],
    ['an empty error string', '{"error":""}'],
    ['a whitespace error string', '{"error":"   "}'],
    ['an error object without code or message', '{"error":{"details":"x"}}'],
    ['an error array', '{"error":[]}'],
    ['isError false', '{"isError":false,"error":null}'],
    ['plain text mentioning error', 'No "error" here, just text'],
    ['a number', '42'],
    ['a string primitive', '"error"'],
    ['an empty string', ''],
    ['the present_choices stub', '{"presented":true}'],
  ])('treats %s as success', (_label, result) => {
    expect(detectToolFailure(result)).toBe(false);
  });
});

describe('extractToolFailureMessage', () => {
  it('prefers the error string, then code + message', () => {
    expect(extractToolFailureMessage('{"error":"Item not found"}')).toBe('Item not found');
    expect(extractToolFailureMessage('{"status":"error","error":{"code":"X","message":"y"}}')).toBe('X: y');
    expect(extractToolFailureMessage('{"error":{"message":"only message"}}')).toBe('only message');
    expect(extractToolFailureMessage('{"error":{"code":"ONLY_CODE"}}')).toBe('ONLY_CODE');
    expect(extractToolFailureMessage('{"isError":true,"message":"top-level message"}')).toBe('top-level message');
  });

  it('returns undefined for successes and non-JSON', () => {
    expect(extractToolFailureMessage('[{"title":"Trial and Error"}]')).toBeUndefined();
    expect(extractToolFailureMessage('plain')).toBeUndefined();
    expect(extractToolFailureMessage('{"status":"ok"}')).toBeUndefined();
  });
});
