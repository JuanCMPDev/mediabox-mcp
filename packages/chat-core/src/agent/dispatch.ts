/* ─── Argument Validation and Tool Dispatch ─────────────────────────────────
 * Strict JSON schema validation before dispatch and single repair (§2.5 / AGT-01).
 * ──────────────────────────────────────────────────────────────────────── */
import _Ajv from 'ajv';
const AjvClass: any = (_Ajv as any).default ?? _Ajv;
import type { VirtualToolDef, McpCallFn } from '../types.js';
import { executeVirtualTool, resolveVirtualCall } from '../tool-router.js';
import { detectToolFailure, extractToolFailureMessage } from '../result-budget.js';
import { computeArgsHash, computeResultDigest } from './guards.js';
import { AgentError } from './errors.js';
import { canonicalPathKey, observedMediaRefs, observedReleaseRefs, type WorkflowReferences } from './workflow.js';

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
  /** Arguments after normalizeArgs: what was validated and dispatched. */
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

const CATALOG_TO_LIBRARY_TYPE: Record<string, string> = { movie: 'Movie', series: 'Series' };
const LIBRARY_FALLBACK_ITEMS = 5;

/** Sources of an envelope that did not answer completely. */
function incompleteSources(parsed: any): string[] {
  const sources = Array.isArray(parsed?.sources) ? parsed.sources : [];
  return sources
    .filter((s: any) => s && typeof s.completeness === 'string' && s.completeness !== 'complete')
    .map((s: any) => String(s.source ?? 'a source'));
}

/**
 * Turns results the model misread in G10 experiment 5 into ones it can answer from.
 * - A partial result names the sources that did not answer, so missing data is
 *   not reported as absent (READ-10, SEARCH-10).
 * - An empty, complete catalog search is completed with a library search. The
 *   catalog covers Radarr/Sonarr, and a title that only exists in the library
 *   was reported as missing (READ-13). A hint alone made the model invent
 *   library results instead of searching, so the runtime searches itself.
 * Notes go in `message` and matches in `library`, which compaction keeps.
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.message !== undefined) return raw;

  const missing = incompleteSources(parsed);
  if (missing.length > 0) {
    return JSON.stringify({ ...parsed, message: `Incomplete: ${missing.join(', ')} did not answer, so its results are missing. Say so; do not call them absent.` });
  }
  if (toolName !== 'catalog' || args.action !== 'search' || !Array.isArray(parsed.data) || parsed.data.length > 0) return raw;
  if (!exposedTools.some(t => t.name === 'media_query')) return raw;
  // Only a result that declares its sources complete is known to be empty.
  if (!Array.isArray(parsed.sources) || !parsed.sources.some((s: any) => s?.completeness === 'complete')) return raw;

  const { args: libraryArgs } = resolveVirtualCall('media_query', {
    action: 'search',
    query: args.query,
    type: CATALOG_TO_LIBRARY_TYPE[String(args.type ?? '')],
    year: args.year,
  });
  try {
    const library = JSON.parse(await mcpCall('jellyfin_search', { ...libraryArgs, pageSize: LIBRARY_FALLBACK_ITEMS }, { signal }));
    if (!Array.isArray(library?.results)) return raw;
    const matches = library.results.slice(0, LIBRARY_FALLBACK_ITEMS).map((r: any) => ({ name: r?.name, type: r?.type, year: r?.year, id: r?.id }));
    return JSON.stringify({ ...parsed, message: matches.length > 0 ? LIBRARY_MATCH_NOTE : NOTHING_FOUND_NOTE, library: matches });
  } catch {
    return raw;
  }
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
  const args = normalizeArgs(opts.args, exposedTools.find(t => t.name === toolName)?.parameters);

  // 1. Validation before dispatch (§2.5 / AGT-01)
  const schemaValidation = validateToolCall(toolName, args, exposedTools);
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
  const resultText = ok ? await annotateResult(toolName, args, rawResult, exposedTools, mcpCall, signal) : rawResult;

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
