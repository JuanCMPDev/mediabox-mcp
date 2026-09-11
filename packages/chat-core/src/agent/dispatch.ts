/* ─── Argument Validation and Tool Dispatch ─────────────────────────────────
 * Strict JSON schema validation before dispatch and single repair (§2.5 / AGT-01).
 * ──────────────────────────────────────────────────────────────────────── */
import _Ajv from 'ajv';
const AjvClass: any = (_Ajv as any).default ?? _Ajv;
import type { VirtualToolDef, McpCallFn } from '../types.js';
import { executeVirtualTool } from '../tool-router.js';
import { detectToolFailure, extractToolFailureMessage } from '../result-budget.js';
import { computeArgsHash, computeResultDigest } from './guards.js';
import { AgentError } from './errors.js';

const ajv = new AjvClass({
  strict: false, // schemas may lack draft declaration
  allErrors: true,
  coerceTypes: false, // strict types without silent coercion
});

const COMPILED_SCHEMAS = new Map<string, any>();

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
    } catch {
      // Fallback permissive compiler if schema has quirks
      validator = ajv.compile(toolDef.parameters);
    }
    COMPILED_SCHEMAS.set(cacheKey, validator);
  }
  return validator;
}

export interface DispatchValidationResult {
  valid: boolean;
  error?: string;
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
      error: `Tool '${toolName}' is not exposed in the current workflow phase`,
    };
  }

  // Strict check on action enum
  const allowedActions = (toolDef.parameters as any)?.properties?.action?.enum as string[] | undefined;
  if (allowedActions && typeof args?.action === 'string') {
    if (!allowedActions.includes(args.action)) {
      return {
        valid: false,
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
      error: `Validation error for tool '${toolName}': ${errorDetails}`,
    };
  }

  return { valid: true };
}

export interface DispatchResult {
  tool: string;
  argsHash: string;
  result: string;
  resultDigest: string;
  ok: boolean;
  rejected: boolean;
  errorMessage?: string;
  durationMs: number;
}

export async function dispatchToolCall(opts: {
  toolName: string;
  args: Record<string, unknown>;
  exposedTools: VirtualToolDef[];
  mcpCall: McpCallFn;
  timeoutMs?: number;
}): Promise<DispatchResult> {
  const { toolName, args, exposedTools, mcpCall, timeoutMs = 150_000 } = opts;
  const argsHash = computeArgsHash(args);
  const t0 = Date.now();

  // 1. Validation before dispatch (§2.5 / AGT-01)
  const validation = validateToolCall(toolName, args, exposedTools);
  if (!validation.valid) {
    const errorPayload = JSON.stringify({
      status: 'error',
      error: {
        code: 'ERR_ARGS_INVALID',
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
      errorMessage: validation.error,
      durationMs: Date.now() - t0,
    };
  }

  // 2. Dispatch with timeout
  let rawResult: string;
  let errorMessage: string | undefined;
  try {
    rawResult = await Promise.race([
      executeVirtualTool(toolName, args, mcpCall),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new AgentError('ERR_TOOL_TIMEOUT', `Tool '${toolName}' timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  } catch (err: any) {
    errorMessage = err instanceof Error ? err.message : String(err);
    rawResult = JSON.stringify({
      status: 'error',
      error: {
        code: err?.code ?? 'ERR_TOOL_EXECUTION',
        message: errorMessage,
      },
    });
  }

  const durationMs = Date.now() - t0;
  const failed = detectToolFailure(rawResult);
  const ok = !failed && !errorMessage;

  return {
    tool: toolName,
    argsHash,
    result: rawResult,
    resultDigest: computeResultDigest(rawResult),
    ok,
    rejected: false,
    errorMessage: errorMessage ?? (ok ? undefined : extractToolFailureMessage(rawResult)),
    durationMs,
  };
}
