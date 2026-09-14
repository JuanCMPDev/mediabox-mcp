/* ─── Argument Validation and Tool Dispatch ─────────────────────────────────
 * Strict JSON schema validation before dispatch and single repair (§2.5 / AGT-01).
 * ──────────────────────────────────────────────────────────────────────── */
import _Ajv from 'ajv';
const AjvClass: any = (_Ajv as any).default ?? _Ajv;
import type { VirtualToolDef, McpCallFn } from '../types.js';
import { executeVirtualTool, resolveVirtualCall } from '../tool-router.js';
import { detectToolFailure, extractToolFailureMessage, safeSlice } from '../result-budget.js';
import { computeArgsHash, computeResultDigest } from './guards.js';
import { AgentError } from './errors.js';
import { TOOL_RESULT_STRING_CAP } from './budget.js';
import {
  canonicalPathKey,
  isValidMediaRef,
  isValidReleaseRef,
  observedMediaRefs,
  observedReleaseRefs,
  type WorkflowReferences,
} from './workflow.js';

const ajv = new AjvClass({
  strict: false, // schemas may lack draft declaration
  allErrors: true,
  coerceTypes: false, // strict types without silent coercion
});

const COMPILED_SCHEMAS = new Map<string, any>();

/**
 * Fail-closed fallback used only if Ajv refuses a quirky schema: rejects unknown
 * top-level properties and missing required ones, so `additionalProperties:false`
 * is never silently dropped (§2.5 / AGT-01).
 */
function buildStrictFallback(parameters: Record<string, any>): any {
  const allowed = new Set(Object.keys(parameters?.properties ?? {}));
  const required: string[] = Array.isArray(parameters?.required) ? parameters.required : [];
  const validator: any = (args: Record<string, unknown>) => {
    const errors: Array<{ instancePath: string; message: string }> = [];
    for (const key of Object.keys(args ?? {})) {
      if (!allowed.has(key)) errors.push({ instancePath: `/${key}`, message: 'must NOT have additional properties' });
    }
    for (const key of required) {
      if (args?.[key] === undefined) errors.push({ instancePath: `/${key}`, message: 'is required' });
    }
    validator.errors = errors.length > 0 ? errors : null;
    return errors.length === 0;
  };
  return validator;
}

function getValidator(toolDef: VirtualToolDef): any {
  const cacheKey = `${toolDef.name}:${JSON.stringify(toolDef.parameters)}`;
  let validator = COMPILED_SCHEMAS.get(cacheKey);
  if (!validator) {
    const schema = {
      ...toolDef.parameters,
      additionalProperties: false,
    };
    try {
      validator = ajv.compile(schema);
    } catch (err) {
      console.warn(
        `[agent] schema for '${toolDef.name}' could not be compiled strictly (${(err as Error).message}); using the fail-closed fallback`,
      );
      validator = buildStrictFallback(toolDef.parameters as Record<string, any>);
    }
    COMPILED_SCHEMAS.set(cacheKey, validator);
  }
  return validator;
}

/**
 * One validation error in words a small model can act on. An unknown property is
 * named first, with the exposed tool that declares it and the properties this tool
 * accepts: "root must NOT have additional properties" alone made the model repeat
 * the same call until the loop guard stopped the turn.
 */
function describeValidationError(e: any, toolDef: VirtualToolDef, exposedTools: VirtualToolDef[]): string {
  const fromFallback = e?.message === 'must NOT have additional properties' && typeof e?.instancePath === 'string' && e.instancePath.length > 1
    ? e.instancePath.slice(1)
    : undefined;
  const unknown = e?.keyword === 'additionalProperties' ? e?.params?.additionalProperty : fromFallback;
  if (typeof unknown === 'string') {
    const allowed = Object.keys((toolDef.parameters as any)?.properties ?? {});
    const owner = exposedTools.find(t => t.name !== toolDef.name && (t.parameters as any)?.properties?.[unknown] !== undefined);
    return `unknown property '${unknown}'${owner ? ` (${owner.name} accepts it)` : ''}; ${toolDef.name} accepts: ${allowed.join(', ')}`;
  }
  return `${e?.instancePath || 'root'} ${e?.message}`;
}

export interface DispatchValidationResult {
  valid: boolean;
  error?: string;
  code?: 'ERR_TOOL_NOT_EXPOSED' | 'ERR_ARGS_INVALID';
}

export function validateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  exposedTools: VirtualToolDef[],
): DispatchValidationResult {
  const toolDef = exposedTools.find(t => t.name === toolName);
  if (!toolDef) {
    return {
      valid: false,
      code: 'ERR_TOOL_NOT_EXPOSED',
      error: `Tool '${toolName}' is not exposed in the current workflow phase`,
    };
  }

  // Strict check on action enum
  const allowedActions = (toolDef.parameters as any)?.properties?.action?.enum as string[] | undefined;
  if (allowedActions && typeof args?.action === 'string') {
    if (!allowedActions.includes(args.action)) {
      return {
        valid: false,
        code: 'ERR_ARGS_INVALID',
        error: `Action '${args.action}' is not permitted for tool '${toolName}' in this phase. Allowed: ${allowedActions.join(', ')}`,
      };
    }
  }

  const validator = getValidator(toolDef);
  const isValid = validator(args);
  if (!isValid && validator.errors) {
    const errorDetails = validator.errors
      .map((e: any) => describeValidationError(e, toolDef, exposedTools))
      .join('; ');
    return {
      valid: false,
      code: 'ERR_ARGS_INVALID',
      error: `Validation error for tool '${toolName}': ${errorDetails}`,
    };
  }

  return { valid: true };
}

export interface DispatchResult {
  tool: string;
  /** Arguments after normalizeArgs and the propose_delete `path`/`paths` repairs: what was validated and dispatched. */
  args?: Record<string, unknown>;
  /** Concrete MCP tool the virtual call resolved to — surfaced as `source=` in the envelope. */
  mcpTool?: string;
  argsHash: string;
  result: string;
  resultDigest: string;
  ok: boolean;
  rejected: boolean;
  errorCode?: string;
  errorMessage?: string;
  durationMs: number;
}

/**
 * Normalizes benign formatting variance of small models against the published
 * schema, before validation: a null value means the property was omitted, an enum
 * string matches case-insensitively, and a number outside a declared bound is
 * clamped to it. Unknown properties, wrong types and missing required values are
 * left untouched for the strict validator (AGT-01).
 */
export function normalizeArgs(args: Record<string, unknown>, parameters?: Record<string, any>): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const properties: Record<string, any> = parameters?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    const schema = properties[key];
    if (schema && typeof value === 'string' && Array.isArray(schema.enum)) {
      const wanted = value.trim().toLowerCase();
      out[key] = schema.enum.find((option: unknown) => typeof option === 'string' && option.toLowerCase() === wanted) ?? value;
    } else if (schema && typeof value === 'number' && Number.isFinite(value) && (schema.type === 'number' || schema.type === 'integer')) {
      let clamped = value;
      if (typeof schema.minimum === 'number' && clamped < schema.minimum) clamped = schema.minimum;
      if (typeof schema.maximum === 'number' && clamped > schema.maximum) clamped = schema.maximum;
      out[key] = clamped;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A proposal may only target what the conversation verified: a release returned by
 * a complete read or chosen by the owner, exact files from a complete listing, or a
 * file with a complete analysis. Phase availability never authorizes substituting
 * another reference or path, and the MCP server verifies them again (§2.7).
 */
export function validateProposalGrounding(
  tool: string,
  args: Record<string, unknown>,
  references: WorkflowReferences = {},
  now: string = new Date().toISOString(),
): DispatchValidationResult {
  const proposal = (tool === 'library_ops' && args.action === 'propose_delete') ||
    (tool === 'media_format' && args.action === 'propose') ||
    (tool === 'catalog' && args.action === 'propose_download');
  if (!proposal) return { valid: true };
  const reject = (error: string): DispatchValidationResult => ({ valid: false, code: 'ERR_ARGS_INVALID', error });
  if (references.expiresAt && !(Date.parse(references.expiresAt) > Date.parse(now))) {
    return reject('References expired. Read the target again before proposing.');
  }
  if (tool === 'catalog') {
    const releaseRef = typeof args.releaseRef === 'string' ? args.releaseRef.trim() : '';
    if (!observedReleaseRefs(references).includes(releaseRef)) {
      return reject('releaseRef must be copied from a catalog(action:"releases") result or from the owner\'s selection in this conversation.');
    }
    if (args.mediaRef !== undefined &&
        !(typeof args.mediaRef === 'string' && observedMediaRefs(references).includes(args.mediaRef.trim()))) {
      return reject('mediaRef must be copied from a catalog result in this conversation; omit it otherwise.');
    }
  } else if (tool === 'library_ops') {
    const listed = new Set((references.paths ?? []).map(canonicalPathKey));
    const paths = typeof args.paths === 'string' ? [args.paths] : args.paths;
    if (!Array.isArray(paths) || paths.length === 0 ||
        paths.some(path => typeof path !== 'string' || !listed.has(canonicalPathKey(path)))) {
      return reject('Each path must be an exact file path returned by library_ops(action:"list"). List the folder and copy the paths of the requested files only.');
    }
  } else {
    const analyzed = new Set((references.inspectedPaths ?? []).map(canonicalPathKey));
    if (typeof args.path !== 'string' || !analyzed.has(canonicalPathKey(args.path))) {
      return reject('Call media_format(action:"analyze") on this exact file before proposing a job for it.');
    }
  }
  return { valid: true };
}

export const LIBRARY_MATCH_NOTE = 'No catalog match; the local library has the titles listed in `library`. Answer from them.';
export const NOTHING_FOUND_NOTE = 'No match in the catalog or in the local library.';
/**
 * A service that did not answer will not answer the same call later in the turn.
 * SEARCH-10, experiment 6: with Sonarr down, qwen3.5 repeated the identical catalog
 * search until ERR_LOOP_DETECTED. Fits the 120 characters compaction keeps of `message`.
 */
export const UPSTREAM_UNAVAILABLE_NOTE = 'The service did not answer. Do not repeat this call in this turn; tell the user its results are unavailable.';

const CATALOG_TO_LIBRARY_TYPE: Record<string, string> = { movie: 'Movie', series: 'Series' };
const LIBRARY_FALLBACK_ITEMS = 5;
/** Room for each query a retry note quotes, so the note fits TOOL_RESULT_STRING_CAP. */
const NOTE_QUERY_CAP = 34;

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Sources of an envelope that did not answer completely. */
function incompleteSources(parsed: any): string[] {
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  return sources
    .filter((s: any) => s && typeof s.completeness === 'string' && s.completeness !== 'complete')
    .map((s: any) => String(s.source ?? 'a source'));
}

/**
 * The domain each source serves, in the words an answer about it uses. READ-10 and
 * SEARCH-10, experiment 7: with Sonarr down, qwen3.5 answered that the series had no
 * results; "sonarr did not answer" named the service but not what was missing.
 * Unknown sources keep their own name.
 */
const SOURCE_DOMAINS: Record<string, string> = {
  sonarr: 'series',
  radarr: 'movie',
  jellyfin: 'library',
  qbittorrent: 'download client',
};
/** Placeholders for a source without a name: they name no domain either. */
const UNNAMED_SOURCES: ReadonlySet<string> = new Set(['a source', 'a service']);

/** "a", "a and b", "a, b and c". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What the results of `names` are about: "series", "series and movie"; "some" when a source has no name. */
export function missingDomains(names: string[]): string {
  if (names.length === 0 || names.some(name => UNNAMED_SOURCES.has(name))) return 'some';
  return listNames([...new Set(names.map(name => SOURCE_DOMAINS[name.trim().toLowerCase()] ?? name))]);
}

/**
 * The note of a partial result: which sources did not respond, what is missing in
 * domain words, and what to tell the user (READ-10, SEARCH-10). Experiment 7: "Say
 * so; do not call its results absent" was ignored in READ-10 (0/3), while in
 * experiment 6 "so its results are missing" was relayed in 2 of 3 passes. The note
 * no longer says not to repeat the call: the runtime replays the first identical
 * repeat (runtime.ts, sourceFailures). It fits the 120 characters compaction keeps of
 * `message`: past them the domains become "its"/"their", then the names a count.
 */
export function incompleteNote(missing: string[]): string {
  const note = (names: string, what: string) =>
    `Incomplete: ${names} did not respond, so ${what} results are missing. Tell the user; do not say none exist.`;
  const unique = [...new Set(missing)];
  const pronoun = unique.length === 1 ? 'its' : 'their';
  for (const candidate of [note(listNames(unique), missingDomains(unique)), note(listNames(unique), pronoun)]) {
    if (candidate.length <= TOOL_RESULT_STRING_CAP) return candidate;
  }
  return note(unique.length === 1 ? 'a source' : `${unique.length} sources`, pronoun);
}

/** A leading type word ("película", "the movie", "la serie"), with its article if any. */
const TYPE_WORD = /^(?:(la|el|los|las|un|una|the|a|an)\s+)?(?:pel[ií]culas?|films?|movies?|series?|shows?|documental(?:es)?|documentar(?:y|ies)|animes?)(?=[\s:]|$)/iu;
/** A linking word after the type word: "película del …", "a film called …". */
const TYPE_LINK = /^\s+(del|de|of|called|llamad[ao]s?|titulad[ao]s?)\s+(?=\S)/iu;
/**
 * The article after "de"/"of" when it is lowercase. Case-sensitive on purpose (review
 * finding D1): "la serie de Los Guardianes del Puerto" keeps "Los", the title's own
 * article, while "Pelicula de la Tierra Media" drops "la". Trade-off: in an all-
 * lowercase "película de las estrellas" the article is dropped even if the title is
 * "Las estrellas"; the shorter query still matches it as a substring in Jellyfin.
 */
const LINK_ARTICLE = /^(?:la|los|las|el|the)\s+(?=\S)/u;
/** A separator between the type word and the title: "película: Eclipse", "película - Eclipse". */
const TYPE_SEPARATOR = /^\s*:\s*|^\s+[-–—]\s+/u;
const QUOTE_CHARS = `"'“”‘’«»„`;
const OPENING_QUOTE = new RegExp(`^\\s+(?=[${QUOTE_CHARS}])`, 'u');
const STARTS_WITH_QUOTE = new RegExp(`^[${QUOTE_CHARS}]`, 'u');
const EDGE_QUOTE = new RegExp(`^[${QUOTE_CHARS}]|[${QUOTE_CHARS}]$`, 'u');
/**
 * A quoted title, optionally followed by its year, bare or in parentheses, after an
 * optional comma and "de", "del", "from" or "of": '"Eclipse"', '"Eclipse" (2017)',
 * '«Eclipse» 2017', '"Eclipse", de 2017' (review findings D1 and F5).
 */
const QUOTED_TITLE = new RegExp(
  `^[${QUOTE_CHARS}]+(.+?)[${QUOTE_CHARS}]+(?:\\s*[,;:]?\\s*(?:(?:de|del|from|of)\\s+)?(?:\\(((?:19|20)\\d{2})\\)|((?:19|20)\\d{2})))?$`,
  'iu',
);
/** Sentence punctuation after the query: '"Eclipse" (2017).' (review finding F5). */
const TRAILING_PUNCTUATION = /\s*[.,;!?]+$/u;

/**
 * Drops the quotes around a title that opens with one. A quoted title followed by its
 * year becomes "Title (YYYY)", the form splitTitleYear (tool-router.ts) splits: review
 * finding F5 saw '«Eclipse» 2017' become "Eclipse 2017", which lost the year, and
 * 'Película "Eclipse", de 2017' become 'Eclipse", de 2017'. Only a quoted title gets
 * its year this way, so "Blade Runner 2049" keeps its number. An opening quote without
 * its closing one gives undefined rather than a title with one quote stripped.
 */
function unquoteTitle(text: string): string | undefined {
  const trimmed = text.trim();
  if (!STARTS_WITH_QUOTE.test(trimmed)) return trimmed;
  const quoted = QUOTED_TITLE.exec(trimmed);
  const title = quoted?.[1].trim();
  if (!quoted || !title) return undefined;
  const year = quoted[2] ?? quoted[3];
  return year ? `${title} (${year})` : title;
}

/**
 * Drops a leading type phrase only when something marks the type word as not part of
 * the title (review finding D1): an article before it ("la serie Marea Alta"), a
 * linking word after it ("película del colibrí azul"), a separator ("película:
 * Eclipse") or a quoted title ('película "Eclipse"'). A bare type word may be the
 * title's own first word: "Serie Ñandú", "Movie 43" and "Show Me Love" stay whole.
 */
function stripTypePhrase(text: string): string {
  const head = TYPE_WORD.exec(text);
  if (!head) return text;
  let rest = text.slice(head[0].length);
  const link = TYPE_LINK.exec(rest);
  if (link) {
    rest = rest.slice(link[0].length);
    if (/^(?:de|of)$/i.test(link[1])) rest = rest.replace(LINK_ARTICLE, '');
  } else if (TYPE_SEPARATOR.test(rest)) {
    rest = rest.replace(TYPE_SEPARATOR, '');
  } else if (head[1] === undefined && !OPENING_QUOTE.test(rest)) {
    return text;
  }
  rest = rest.trim();
  return rest.length > 0 ? rest : text;
}

/**
 * The title inside a query that wraps it in a type phrase or in quotes. READ-13,
 * experiments 5 and 6: "Busca la película del colibrí azul" was searched as
 * "película del colibrí azul", which matches no title, and the answer was that the
 * film did not exist. Undefined when nothing changes or nothing is left, so a plain
 * title ("El Señor de los Anillos") is never searched twice. Undefined too when a quote
 * is unbalanced: the query stays as the model wrote it (review finding F5).
 */
export function normalizeTitleQuery(query: unknown): string | undefined {
  if (typeof query !== 'string') return undefined;
  // Trailing sentence punctuation is not part of the title, but dropping it alone is
  // no new query: "Airplane!" is still searched once (F5).
  const sentence = query.normalize('NFC').trim().replace(TRAILING_PUNCTUATION, '');
  const outer = unquoteTitle(sentence);
  const title = outer === undefined ? undefined : unquoteTitle(stripTypePhrase(outer));
  // A quote left at either edge lost its pair.
  if (!title || EDGE_QUOTE.test(title) || title === sentence) return undefined;
  return title;
}

function clipForNote(text: string): string {
  return text.length > NOTE_QUERY_CAP ? `${safeSlice(text, NOTE_QUERY_CAP - 1)}…` : text;
}

/** Says that the results answer the normalized query, not the one the model wrote. */
export function retryNote(original: string, normalized: string): string {
  return `No match for "${clipForNote(original)}"; these results are for "${clipForNote(normalized)}".`;
}

/**
 * The normalized title a search result answers when it is the retry of an empty search,
 * which the result's message says with retryNote. Undefined for every other result: a
 * search that found items as written answers its own query. Review finding F3: a
 * search for "El Show de Truman" is not a search for "Truman".
 */
export function retriedTitle(query: unknown, message: unknown): string | undefined {
  if (typeof query !== 'string' || typeof message !== 'string') return undefined;
  const normalized = normalizeTitleQuery(query);
  return normalized !== undefined && message === retryNote(query.trim(), normalized) ? normalized : undefined;
}

/** An extra read made on behalf of a result. It goes through mcpCall, so it is audited like any call. */
async function readJson(mcpCall: McpCallFn, tool: string, toolArgs: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  try {
    return JSON.parse(await mcpCall(tool, toolArgs, { signal }));
  } catch {
    return undefined;
  }
}

interface TitleRetry {
  /** The retried result with its note, when the retry found items. */
  result?: string;
  /** Sources the retry reported as incomplete. */
  missing: string[];
}

/**
 * Repeats an empty search once with the normalized title (READ-13). The first call
 * always goes as the model wrote it. The retry is resolved by the same router, so
 * type, year and page size keep their handling, and its note says which query the
 * results answer. A retry with incomplete sources carries incompleteNote instead
 * (review finding D2): the model must hear that a source did not answer, as it does
 * for a first result.
 */
async function retryWithTitle(
  toolName: 'catalog' | 'media_query',
  args: Record<string, unknown>,
  normalized: string,
  mcpCall: McpCallFn,
  signal?: AbortSignal,
): Promise<TitleRetry> {
  const call = resolveVirtualCall(toolName, { action: 'search', query: normalized, type: args.type, year: args.year, pageSize: args.pageSize });
  const retried = await readJson(mcpCall, call.tool, call.args, signal);
  if (!isRecord(retried) || retried.status === 'error' || retried.error !== undefined) return { missing: [] };
  const missing = incompleteSources(retried);
  const items = toolName === 'catalog' ? retried.data : retried.results;
  if (!Array.isArray(items) || items.length === 0) return { missing };
  const message = missing.length > 0 ? incompleteNote(missing) : retryNote(String(args.query).trim(), normalized);
  return { result: JSON.stringify({ ...retried, message }), missing };
}

/**
 * Turns results the model misread in G10 into ones it can answer from.
 * - A partial result names the sources that did not answer and what is missing in
 *   domain words, so missing data is not reported as absent (READ-10, SEARCH-10).
 * - An empty search whose query wraps the title in a type phrase is repeated once
 *   with the title alone (READ-13, experiments 5 and 6).
 * - An empty, complete catalog search is completed with a library search. The
 *   catalog covers Radarr/Sonarr, and a title that only exists in the library
 *   was reported as missing (READ-13). A hint alone made the model invent
 *   library results instead of searching, so the runtime searches itself.
 * At most two extra MCP calls per result. Notes go in `message` and matches in
 * `library`, which compaction keeps.
 */
async function annotateResult(
  toolName: string,
  args: Record<string, unknown>,
  raw: string,
  exposedTools: VirtualToolDef[],
  mcpCall: McpCallFn,
  signal?: AbortSignal,
): Promise<string> {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed) || parsed.message !== undefined) return raw;

  const missing = incompleteSources(parsed);
  if (missing.length > 0) {
    return JSON.stringify({ ...parsed, message: incompleteNote(missing) });
  }
  if (args.action !== 'search') return raw;
  const normalized = normalizeTitleQuery(args.query);
  if (toolName === 'media_query') {
    if (!normalized || !Array.isArray(parsed.results) || parsed.results.length > 0) return raw;
    return (await retryWithTitle('media_query', args, normalized, mcpCall, signal)).result ?? raw;
  }
  if (toolName !== 'catalog' || !Array.isArray(parsed.data) || parsed.data.length > 0) return raw;
  // Only a result that declares its sources complete is known to be empty.
  if (!Array.isArray(parsed.sources) || !parsed.sources.some((s: any) => s?.completeness === 'complete')) return raw;

  // Sources the title retry reported as incomplete. With them, "no match" is not
  // known for the title, so the no-match note gives way to incompleteNote (D2).
  let retryMissing: string[] = [];
  if (normalized) {
    const retry = await retryWithTitle('catalog', args, normalized, mcpCall, signal);
    if (retry.result) return retry.result;
    retryMissing = retry.missing;
  }
  const retryIncomplete = retryMissing.length > 0 ? incompleteNote(retryMissing) : undefined;
  if (!exposedTools.some(t => t.name === 'media_query')) {
    return retryIncomplete ? JSON.stringify({ ...parsed, message: retryIncomplete }) : raw;
  }

  const { args: libraryArgs } = resolveVirtualCall('media_query', {
    action: 'search',
    query: normalized ?? args.query,
    type: CATALOG_TO_LIBRARY_TYPE[String(args.type ?? '')],
    year: args.year,
  });
  const library = await readJson(mcpCall, 'jellyfin_search', { ...libraryArgs, pageSize: LIBRARY_FALLBACK_ITEMS }, signal);
  if (!Array.isArray(library?.results)) return raw;
  const matches = library.results.slice(0, LIBRARY_FALLBACK_ITEMS).map((r: any) => ({ name: r?.name, type: r?.type, year: r?.year, id: r?.id }));
  const emptyNote = retryIncomplete ?? NOTHING_FOUND_NOTE;
  return JSON.stringify({ ...parsed, message: matches.length > 0 ? LIBRARY_MATCH_NOTE : emptyNote, library: matches });
}

/**
 * A failed result from a service that did not answer (ERR_UPSTREAM_UNAVAILABLE) says
 * not to repeat the call (SEARCH-10, experiment 6). The `error` object stays;
 * validation rejections and every other code are left as they are.
 */
function annotateFailure(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isRecord(parsed) || parsed.message !== undefined) return raw;
  if (!isRecord(parsed.error) || parsed.error.code !== 'ERR_UPSTREAM_UNAVAILABLE') return raw;
  return JSON.stringify({ ...parsed, message: UPSTREAM_UNAVAILABLE_NOTE });
}

/**
 * `path` for `paths` in a deletion proposal. STORAGE-02, experiment 6: qwen3.5 called
 * library_ops({"action":"propose_delete","path":"media:movies/…"}) in three passes of
 * three; the router reads only `paths`, so the call failed until the loop guard. Only
 * the name of the argument changes: grounding still checks the path against the
 * listing, and DispatchResult.args carries the renamed form the runtime derives the
 * proposal targets from.
 */
function aliasDeletePath(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== 'library_ops' || !isRecord(args) || args.action !== 'propose_delete') return args;
  if (args.paths !== undefined) return decodeDeletePaths(args);
  if (typeof args.path !== 'string' || args.path.trim().length === 0) return args;
  const { path, ...rest } = args;
  return { ...rest, paths: [path] };
}

/** A `paths` value the router dispatches: a non-empty path, or a non-empty array of them. */
function isUsablePaths(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return Array.isArray(value) && value.length > 0 && value.every(path => typeof path === 'string' && path.trim().length > 0);
}

/**
 * `paths` written as a JSON array in a string. STORAGE-02, experiment 7: qwen3.5 called
 * library_ops({"action":"propose_delete","path":"media:movies/Niebla de Marzo (2015)",
 * "paths":"[\"media:movies/Niebla de Marzo (2015)/Niebla de Marzo (2015).mkv\"]"}) in
 * three passes of three; the router wrapped the text as one path, grounding rejected
 * it and the identical repeat ended on ERR_LOOP_DETECTED. Only text that parses to a
 * non-empty array of non-empty strings is decoded; any other text stays as the model
 * wrote it (ADV-03 asks for a deliberately truncated JSON). With a usable `paths`,
 * `path` goes: the router ignores it for propose_delete, and the effective args must
 * not claim a folder the proposal never targets. Grounding still checks every path.
 */
function decodeDeletePaths(args: Record<string, unknown>): Record<string, unknown> {
  let paths = args.paths;
  if (typeof paths === 'string' && paths.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(paths);
      if (Array.isArray(parsed) && isUsablePaths(parsed)) paths = parsed;
    } catch {
      /* not JSON: dispatched as the model wrote it */
    }
  }
  if (!isUsablePaths(paths)) return args;
  const effective: Record<string, unknown> = { ...args, paths };
  delete effective.path;
  return effective;
}

/** The reference arguments each catalog action forwards to the MCP server. */
const CATALOG_REF_FIELDS: Record<string, Array<'mediaRef' | 'releaseRef'>> = {
  details: ['mediaRef'],
  releases: ['mediaRef'],
  propose_download: ['releaseRef', 'mediaRef'],
};
/** Room for the value a reference error quotes, so two errors fit the 300-character error cap. */
const REF_ECHO_CAP = 24;

function describeRef(field: 'mediaRef' | 'releaseRef', value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : String(value);
  const shown = `'${text.length > REF_ECHO_CAP ? `${safeSlice(text, REF_ECHO_CAP - 1)}…` : text}'`;
  if (field === 'mediaRef') {
    return text.startsWith('rref_')
      ? `mediaRef ${shown} is a releaseRef. Use the mediaRef (mref_...) of a catalog(action:"search") result.`
      : `mediaRef ${shown} is not a catalog reference (media_query ids are not). Use the mediaRef (mref_...) of a catalog(action:"search") result.`;
  }
  return text.startsWith('mref_')
    ? `releaseRef ${shown} is a mediaRef. Use a releaseRef (rref_...) from a catalog(action:"releases") result.`
    : `releaseRef ${shown} is not a release reference. Use a releaseRef (rref_...) from a catalog(action:"releases") result.`;
}

/**
 * Names a catalog reference of the wrong kind before it reaches the MCP server.
 * SEARCH-10, experiment 5: qwen2.5 sent mediaRef "jf-series-guard", a media_query id,
 * to releases and details; ADV-02, experiment 5: it sent rref_7f3a9c2e1b4d as the
 * mediaRef of details. The server's refusal did not say which token to use instead.
 */
function describeInvalidRefs(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName !== 'catalog' || !isRecord(args)) return undefined;
  const problems: string[] = [];
  for (const field of CATALOG_REF_FIELDS[String(args.action)] ?? []) {
    const value = args[field];
    if (value === undefined) continue;
    const valid = field === 'mediaRef' ? isValidMediaRef(value) : isValidReleaseRef(value);
    if (!valid) problems.push(describeRef(field, value));
  }
  return problems.length > 0 ? problems.join(' ') : undefined;
}

export async function dispatchToolCall(opts: {
  toolName: string;
  args: Record<string, unknown>;
  exposedTools: VirtualToolDef[];
  mcpCall: McpCallFn;
  references?: WorkflowReferences;
  referenceTime?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  const { toolName, exposedTools, mcpCall, timeoutMs = 150_000, signal } = opts;
  const argsHash = computeArgsHash(opts.args);
  const t0 = Date.now();
  const args = aliasDeletePath(toolName, normalizeArgs(opts.args, exposedTools.find(t => t.name === toolName)?.parameters));

  // 1. Validation before dispatch (§2.5 / AGT-01)
  const schemaValidation = validateToolCall(toolName, args, exposedTools);
  // A catalog reference of the wrong kind never reaches the MCP server. The call
  // failed rather than being rejected, so it never consumes the single schema repair.
  const refError = schemaValidation.valid ? describeInvalidRefs(toolName, args) : undefined;
  if (refError) {
    const errorPayload = JSON.stringify({ status: 'error', error: { code: 'ERR_REF_INVALID', message: refError } });
    return {
      tool: toolName,
      args,
      argsHash,
      result: errorPayload,
      resultDigest: computeResultDigest(errorPayload),
      ok: false,
      rejected: false,
      errorCode: 'ERR_REF_INVALID',
      errorMessage: refError,
      durationMs: Date.now() - t0,
    };
  }
  const validation = schemaValidation.valid
    ? validateProposalGrounding(toolName, args, opts.references, opts.referenceTime)
    : schemaValidation;
  if (!validation.valid) {
    const code = validation.code ?? 'ERR_ARGS_INVALID';
    const errorPayload = JSON.stringify({
      status: 'error',
      error: {
        code,
        message: validation.error,
      },
    });
    return {
      tool: toolName,
      args,
      argsHash,
      result: errorPayload,
      resultDigest: computeResultDigest(errorPayload),
      ok: false,
      rejected: true,
      errorCode: code,
      errorMessage: validation.error,
      durationMs: Date.now() - t0,
    };
  }

  // 2. Dispatch with a timeout that aborts the request and always clears its timer,
  //    and with the turn signal chained so a cancelled turn aborts the call (§2.9).
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let rawResult: string;
  let errorMessage: string | undefined;
  let errorCode: string | undefined;
  let mcpTool: string | undefined;
  try {
    mcpTool = resolveVirtualCall(toolName, args).tool;
  } catch {
    /* the router will raise the same error below with its own message */
  }
  try {
    rawResult = await executeVirtualTool(toolName, args, mcpCall, { signal: controller.signal });
  } catch (err: any) {
    if (timedOut) {
      errorCode = 'ERR_TOOL_TIMEOUT';
      errorMessage = `Tool '${toolName}' timed out after ${timeoutMs}ms`;
    } else if (signal?.aborted) {
      errorCode = 'ERR_CANCELLED';
      errorMessage = `Tool '${toolName}' was cancelled`;
    } else {
      errorCode = err?.code ?? 'ERR_TOOL_EXECUTION';
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    rawResult = JSON.stringify({
      status: 'error',
      error: { code: errorCode, message: errorMessage },
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (errorCode === 'ERR_CANCELLED') {
    throw new AgentError('ERR_CANCELLED', errorMessage ?? 'Turn cancelled during tool execution');
  }
  if (errorCode === 'ERR_TOOL_TIMEOUT') {
    throw new AgentError('ERR_TOOL_TIMEOUT', errorMessage ?? `Tool '${toolName}' timed out`);
  }

  const durationMs = Date.now() - t0;
  const failed = detectToolFailure(rawResult);
  const ok = !failed && !errorMessage;
  const resultText = ok ? await annotateResult(toolName, args, rawResult, exposedTools, mcpCall, signal) : annotateFailure(rawResult);

  return {
    tool: toolName,
    args,
    mcpTool,
    argsHash,
    result: resultText,
    resultDigest: computeResultDigest(resultText),
    ok,
    rejected: false,
    errorCode,
    errorMessage: errorMessage ?? (ok ? undefined : extractToolFailureMessage(rawResult)),
    durationMs,
  };
}
