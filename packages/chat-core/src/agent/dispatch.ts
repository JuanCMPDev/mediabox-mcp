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
      .map((e: any) => `${e.instancePath || 'root'} ${e.message}`)
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

export async function dispatchToolCall(opts: {
  toolName: string;
  args: Record<string, unknown>;
  exposedTools: VirtualToolDef[];
  mcpCall: McpCallFn;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  const { toolName, args, exposedTools, mcpCall, timeoutMs = 150_000, signal } = opts;
  const argsHash = computeArgsHash(args);
  const t0 = Date.now();

  // 1. Validation before dispatch (§2.5 / AGT-01)
  const validation = validateToolCall(toolName, args, exposedTools);
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

  return {
    tool: toolName,
    mcpTool,
    argsHash,
    result: rawResult,
    resultDigest: computeResultDigest(rawResult),
    ok,
    rejected: false,
    errorCode,
    errorMessage: errorMessage ?? (ok ? undefined : extractToolFailureMessage(rawResult)),
    durationMs,
  };
}
