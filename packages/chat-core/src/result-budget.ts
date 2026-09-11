/* ─── Tool result budgeting & structural failure detection ───────────────────
 * Tool text handed to the LLM must be (a) bounded in size and (b) still valid
 * JSON when it started as JSON. A blind character slice produces broken JSON
 * and can split a UTF-16 surrogate pair (emoji in release titles), which some
 * providers reject outright.
 *
 * Failure detection is structural: only top-level `isError`, `status:"error"`
 * or an `error` field count. A nested string that merely contains the word
 * "error" (a release titled "Trial and Error") is NOT a failure.
 * ──────────────────────────────────────────────────────────────────────── */

export const DEFAULT_RESULT_BUDGET_BYTES = 24_000;

const TEXT_TRUNCATION_SUFFIX = '\n…(truncated)';
const ELLIPSIS = '…';

interface PruneLimits {
  /** Max string length (UTF-16 code units) before cutting. */
  str: number;
  /** Max array items kept. */
  arr: number;
  /** Max object keys kept. */
  keys: number;
  /** Max nesting depth before a value is replaced by a marker. */
  depth: number;
}

/** Progressively stricter limits; the first level that fits the budget wins. */
const PRUNE_SCHEDULE: readonly PruneLimits[] = [
  { str: 400, arr: 50, keys: 200, depth: 16 },
  { str: 200, arr: 25, keys: 100, depth: 12 },
  { str: 120, arr: 12, keys:  60, depth: 10 },
  { str:  64, arr:  6, keys:  30, depth:  8 },
  { str:  32, arr:  3, keys:  15, depth:  6 },
  { str:  16, arr:  1, keys:   8, depth:  4 },
];

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number):  boolean { return code >= 0xdc00 && code <= 0xdfff; }

/** Slice to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function safeSlice(s: string, max: number): string {
  if (max <= 0) return '';
  if (max >= s.length) return s;
  let end = max;
  if (isHighSurrogate(s.charCodeAt(end - 1)) && isLowSurrogate(s.charCodeAt(end))) end--;
  return s.slice(0, end);
}

/** Longest prefix whose UTF-8 encoding fits in `maxBytes`, never splitting a surrogate pair. */
export function cutToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const code  = text.codePointAt(i) as number;
    const units = code > 0xffff ? 2 : 1;
    // Lone surrogates (0xD800–0xDFFF) encode as U+FFFD = 3 bytes, same as Buffer.byteLength.
    const size  = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += units;
  }
  return text.slice(0, i);
}

interface PruneState { truncated: boolean }

function prune(value: unknown, limits: PruneLimits, depth: number, state: PruneState): unknown {
  if (typeof value === 'string') {
    if (value.length <= limits.str) return value;
    state.truncated = true;
    return safeSlice(value, limits.str) + ELLIPSIS;
  }
  if (Array.isArray(value)) {
    if (depth >= limits.depth) {
      state.truncated = true;
      return `${ELLIPSIS}(${value.length} nested items truncated)`;
    }
    const kept = value.length > limits.arr ? value.slice(0, limits.arr) : value;
    const out: unknown[] = kept.map(v => prune(v, limits, depth + 1, state));
    if (value.length > limits.arr) {
      state.truncated = true;
      out.push(`${ELLIPSIS}(${value.length - limits.arr} more items truncated)`);
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= limits.depth) {
      state.truncated = true;
      return `${ELLIPSIS}(nested object truncated)`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = entries.length > limits.keys ? entries.slice(0, limits.keys) : entries;
    const out: Record<string, unknown> = {};
    for (const [k, v] of kept) out[k] = prune(v, limits, depth + 1, state);
    if (entries.length > limits.keys) {
      state.truncated = true;
      out[ELLIPSIS] = `${entries.length - limits.keys} more keys truncated`;
    }
    return out;
  }
  return value; // number | boolean | null
}

/** Attach the top-level `_truncated: true` flag without changing the value's shape. */
function withTruncatedFlag(value: unknown): unknown {
  if (Array.isArray(value)) return [...value, { _truncated: true }];
  if (value !== null && typeof value === 'object') return { ...(value as Record<string, unknown>), _truncated: true };
  return { _truncated: true, value };
}

/** Guaranteed-valid JSON fallback when structural pruning cannot reach the budget. */
function lastResortJson(text: string, maxBytes: number): string {
  let budget = maxBytes;
  for (let attempt = 0; attempt < 16 && budget > 0; attempt++) {
    const preview = cutToBytes(text, budget);
    const out = JSON.stringify({ _truncated: true, preview });
    const size = utf8Bytes(out);
    if (size <= maxBytes) return out;
    budget -= size - maxBytes; // JSON escaping can inflate the preview; shrink by the overshoot
  }
  return JSON.stringify({ _truncated: true, preview: '' });
}

/**
 * Bound a tool result to `maxBytes` (UTF-8). JSON input stays valid JSON:
 * long strings are cut on a safe code-unit boundary (+ "…"), long arrays keep
 * their first items plus a marker, wide/deep objects are capped, with stricter
 * limits applied until the result fits, and a top-level `_truncated: true` is
 * set when anything was pruned. Non-JSON text is cut on a safe boundary with a
 * "…(truncated)" suffix. Results already within budget are returned as-is.
 */
export function boundToolResultText(text: string, maxBytes: number = DEFAULT_RESULT_BUDGET_BYTES): string {
  const input = typeof text === 'string' ? text : String(text ?? '');
  if (utf8Bytes(input) <= maxBytes) return input;

  let parsed: unknown;
  let isJson = true;
  try { parsed = JSON.parse(input); } catch { isJson = false; }

  if (!isJson) {
    const budget = Math.max(0, maxBytes - utf8Bytes(TEXT_TRUNCATION_SUFFIX));
    return cutToBytes(input, budget) + TEXT_TRUNCATION_SUFFIX;
  }

  for (const limits of PRUNE_SCHEDULE) {
    const state: PruneState = { truncated: false };
    const pruned = prune(parsed, limits, 0, state);
    const out = JSON.stringify(state.truncated ? withTruncatedFlag(pruned) : pruned);
    if (utf8Bytes(out) <= maxBytes) return out;
  }
  return lastResortJson(input, maxBytes);
}

// ── Failure detection ─────────────────────────────────────────────────────────

function parseTopLevelObject(result: string): Record<string, unknown> | null {
  if (typeof result !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(result);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

function errorFieldIsFailure(err: unknown): boolean {
  if (typeof err === 'string') return err.trim().length > 0;
  if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
    const e = err as Record<string, unknown>;
    return typeof e.code === 'string' || typeof e.message === 'string';
  }
  return false;
}

/**
 * True when a tool result represents a failure: a top-level JSON object with
 * `isError === true`, `status === "error"`, or an `error` property that is a
 * non-empty string or an object carrying `code`/`message`. Arrays, primitives
 * and non-JSON text are successes; nested mentions of "error" are ignored.
 */
export function detectToolFailure(result: string): boolean {
  const obj = parseTopLevelObject(result);
  if (!obj) return false;
  if (obj.isError === true) return true;
  if (obj.status === 'error') return true;
  return errorFieldIsFailure(obj.error);
}

/** Best-effort human-readable message for a failed tool result. */
export function extractToolFailureMessage(result: string): string | undefined {
  const obj = parseTopLevelObject(result);
  if (!obj) return undefined;

  const err = obj.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
    const e = err as Record<string, unknown>;
    const code    = typeof e.code    === 'string' && e.code.trim()    ? e.code.trim()    : undefined;
    const message = typeof e.message === 'string' && e.message.trim() ? e.message.trim() : undefined;
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
  }
  if ((obj.isError === true || obj.status === 'error') && typeof obj.message === 'string' && obj.message.trim()) {
    return obj.message.trim();
  }
  return undefined;
}
