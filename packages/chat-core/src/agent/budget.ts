/* ─── Context Budget and Compaction ─────────────────────────────────────────
 * Enforces token allocations and limits (§2.4 / AGT-02 / AGT-07).
 *
 * Tool results are stored raw in the history and only wrapped in the
 * `[tool_result …]` envelope here, at prompt build time, so compaction always
 * sees parseable JSON and the envelope can never be corrupted by its payload.
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatMessage, VirtualToolDef, ToolResultInfo } from '../types.js';
import type { WorkflowState } from './workflow.js';
import { AgentError } from './errors.js';

export interface BudgetConfig {
  contextTokens: number; // 8192
  outputReserve: number; // 1024
  safetyMargin:  number; // 512
  inputBudget:   number; // contextTokens - outputReserve - safetyMargin = 6656
}

export const DEFAULT_BUDGET: BudgetConfig = {
  contextTokens: 8192,
  outputReserve: 1024,
  safetyMargin:  512,
  inputBudget:   6656,
};

/** Per-section caps from §2.4. Exceeding the prompt or tool cap is a build defect. */
export const SYSTEM_PROMPT_TOKEN_CAP = 1400;
export const TOOL_SCHEMA_TOKEN_CAP   = 1200;
export const STATE_SUMMARY_TOKEN_CAP = 600;
export const TOOL_RESULT_TOKEN_CAP   = 700;
export const TOOL_RESULT_STRING_CAP  = 120;
export const TOOL_RESULT_ITEM_CAP    = 5;

/**
 * Derives a budget from an effective context window, keeping the blueprint's
 * proportions (reserve 1024 / margin 512 at 8K) for smaller runtime windows.
 */
export function budgetForContext(contextTokens: number): BudgetConfig {
  const safeContext = Math.max(1024, Math.floor(contextTokens));
  const outputReserve = Math.min(DEFAULT_BUDGET.outputReserve, Math.floor(safeContext / 4));
  const safetyMargin = Math.min(DEFAULT_BUDGET.safetyMargin, Math.floor(safeContext / 8));
  return {
    contextTokens: safeContext,
    outputReserve,
    safetyMargin,
    inputBudget: safeContext - outputReserve - safetyMargin,
  };
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Anything able to turn text into a token estimate: the heuristic or the calibrated counter. */
export interface TokenEstimator {
  estimate(text: string): number;
  /** Estimate from a character count only, avoiding large string allocations. */
  estimateLength?(chars: number): number;
}

export const HEURISTIC_ESTIMATOR: TokenEstimator = {
  estimate: estimateTokenCount,
  estimateLength: (chars: number) => Math.ceil(chars / 3.5),
};

function estimateChars(counter: TokenEstimator, chars: number): number {
  return counter.estimateLength ? counter.estimateLength(chars) : Math.ceil(chars / 3.5);
}

function stripControlChars(text: string): string {
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');
}

/**
 * Builds a deterministic, concise summary of the active workflow state.
 * Hard-capped at STATE_SUMMARY_TOKEN_CAP (§2.4).
 */
export function buildStateSummary(state: WorkflowState, counter: TokenEstimator = HEURISTIC_ESTIMATOR): string {
  const parts: string[] = [
    `[WorkflowState phase=${state.phase} turn=${state.turn}]`,
  ];
  if (state.intent) {
    parts.push(`Intent: ${state.intent.kind} — ${state.intent.summary}`);
  }
  const refParts: string[] = [];
  if (state.references.mediaRef) refParts.push(`mediaRef=${state.references.mediaRef}`);
  if (state.references.releaseRef) refParts.push(`releaseRef=${state.references.releaseRef}`);
  if (state.references.paths?.length) refParts.push(`paths=${state.references.paths.slice(0, 3).join(',')}`);
  if (refParts.length > 0) {
    parts.push(`ActiveReferences: ${refParts.join(' ')}`);
  }
  if (state.candidates.length > 0) {
    parts.push(
      `PresentedCandidates: ${state.candidates
        .slice(0, 5)
        .map(c => `${c.label}${c.releaseRef ? `(${c.releaseRef})` : c.mediaRef ? `(${c.mediaRef})` : ''}`)
        .join(' | ')}`,
    );
  }
  if (state.proposals.length > 0) {
    const active = state.proposals.slice(-3).map(p => `${p.operation}:${p.planId}(${p.status})`);
    parts.push(`RecentPlans: ${active.join(' ')}`);
  }
  if (state.lastToolCalls.length > 0) {
    parts.push(`RecentTools: ${state.lastToolCalls.slice(-4).map(c => c.tool).join(',')}`);
  }

  let summary = stripControlChars(parts.join('\n'));
  // Hard cap: drop trailing sections until it fits rather than emitting an oversized summary.
  while (counter.estimate(summary) > STATE_SUMMARY_TOKEN_CAP && parts.length > 1) {
    parts.pop();
    summary = stripControlChars(parts.join('\n'));
  }
  if (counter.estimate(summary) > STATE_SUMMARY_TOKEN_CAP) {
    summary = summary.slice(0, STATE_SUMMARY_TOKEN_CAP * 3);
  }
  return summary;
}

const SHORT_ITEM_KEYS = new Set([
  'id', 'title', 'name', 'year', 'mediaRef', 'releaseRef', 'score', 'status', 'resolution',
  'size', 'sizeBytes', 'seeders', 'quality', 'language', 'indexer', 'reason', 'reasons',
  'season', 'episode', 'path', 'planId', 'operation', 'state',
]);

function truncateString(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return String(val ?? '');
  const clean = stripControlChars(val);
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}...` : clean;
}

function shortenValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return truncateString(value, TOOL_RESULT_STRING_CAP);
  if (Array.isArray(value)) {
    if (depth >= 2) return `[${value.length} items]`;
    return value.slice(0, TOOL_RESULT_ITEM_CAP).map(v => shortenValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= 2) return '[object]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shortenValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function compactEnvelope(parsed: Record<string, unknown>, itemLimit: number): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};

  if ('status' in parsed) compacted.status = parsed.status;
  if ('sources' in parsed) compacted.sources = shortenValue(parsed.sources);
  if ('page' in parsed) compacted.page = parsed.page;
  if ('error' in parsed) compacted.error = shortenValue(parsed.error);
  if ('message' in parsed) compacted.message = truncateString(parsed.message, TOOL_RESULT_STRING_CAP);
  if ('planId' in parsed) compacted.planId = parsed.planId;
  if ('operation' in parsed) compacted.operation = parsed.operation;
  if ('proposalKey' in parsed) compacted.proposalKey = parsed.proposalKey;
  if ('expiresAt' in parsed) compacted.expiresAt = parsed.expiresAt;
  if ('manifestHash' in parsed) compacted.manifestHash = parsed.manifestHash;

  const data = parsed.data;
  if (Array.isArray(data)) {
    compacted.data = data.slice(0, itemLimit).map((item: unknown) => {
      if (typeof item !== 'object' || item === null) return shortenValue(item);
      const shortItem: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (SHORT_ITEM_KEYS.has(k)) shortItem[k] = shortenValue(v, 1);
      }
      return shortItem;
    });
    compacted.totalCount = data.length;
    if (data.length > itemLimit) compacted.truncated = true;
  } else if (data !== undefined) {
    compacted.data = shortenValue(data);
  } else {
    // Non-envelope payload: keep its own short keys so simple tools still say something.
    for (const [k, v] of Object.entries(parsed)) {
      if (!(k in compacted)) compacted[k] = shortenValue(v, 1);
    }
  }

  return compacted;
}

/**
 * Compacts a raw tool result JSON string to keep it within bounds (§2.4 / AGT-04):
 * - Keeps status, sources, page, error
 * - Maximum 5 data elements with short keys
 * - Strings truncated to 120 characters and stripped of control characters
 * - Total result capped at <= 700 tokens, always emitting valid JSON
 */
export function compactToolResult(
  toolName: string,
  rawResult: string,
  counter: TokenEstimator = HEURISTIC_ESTIMATOR,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    // Not JSON: bound the text and strip control characters.
    return JSON.stringify({ tool: toolName, text: truncateString(rawResult, TOOL_RESULT_TOKEN_CAP * 3) });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return JSON.stringify({ tool: toolName, value: shortenValue(parsed) });
  }

  for (const limit of [TOOL_RESULT_ITEM_CAP, 3, 1]) {
    const serialized = JSON.stringify(compactEnvelope(parsed as Record<string, unknown>, limit));
    if (counter.estimate(serialized) <= TOOL_RESULT_TOKEN_CAP) return serialized;
  }

  // Last resort: a valid minimal envelope instead of a sliced, unparseable string.
  const record = parsed as Record<string, unknown>;
  return JSON.stringify({
    status: record.status ?? 'ok',
    ...(record.error ? { error: shortenValue(record.error) } : {}),
    totalCount: Array.isArray(record.data) ? record.data.length : undefined,
    truncated: true,
  });
}

/** One-line stand-in for tool results older than the last two turns (§2.4). */
export function digestToolResult(toolName: string, rawResult: string, ok = true): string {
  let count: number | undefined;
  let status = ok ? 'ok' : 'error';
  const refs: string[] = [];
  try {
    const parsed = JSON.parse(rawResult) as Record<string, any>;
    if (typeof parsed.status === 'string') status = parsed.status;
    if (Array.isArray(parsed.data)) {
      count = parsed.data.length;
      for (const item of parsed.data.slice(0, 2)) {
        const ref = item?.releaseRef ?? item?.mediaRef;
        if (typeof ref === 'string') refs.push(ref);
      }
    } else if (parsed.data && typeof parsed.data === 'object') {
      const ref = parsed.data.releaseRef ?? parsed.data.mediaRef;
      if (typeof ref === 'string') refs.push(ref);
    }
    if (typeof parsed.planId === 'string') refs.push(parsed.planId);
  } catch {
    /* keep the defaults */
  }
  const parts = [`tool=${toolName}`, `status=${status}`];
  if (count !== undefined) parts.push(`items=${count}`);
  if (refs.length > 0) parts.push(`refs=${refs.join(',')}`);
  return `[tool_digest ${parts.join(' ')}]`;
}

/**
 * Wraps a compacted payload in the data boundary envelope (§2.7). The payload is
 * stripped of control characters and of any literal envelope markers so a tool
 * result can never forge one.
 */
export function wrapToolResult(
  toolName: string,
  payload: string,
  opts: { ok?: boolean; source?: string } = {},
): string {
  const status = opts.ok === false ? 'error' : 'ok';
  const safePayload = stripControlChars(payload)
    .replace(/\[\/?tool_result/gi, '(tool_result')
    .replace(/\[\/?tool_digest/gi, '(tool_digest');
  const source = opts.source ? ` source=${opts.source.replace(/[^A-Za-z0-9_.:-]/g, '')}` : '';
  return `[tool_result tool=${toolName} status=${status}${source}]\n${safePayload}\n[/tool_result]`;
}

export interface PreparedContext {
  systemPrompt: string;
  tools: VirtualToolDef[];
  stateSummary: string;
  messages: ChatMessage[];
  estimatedTokens: number;
  /** Total characters of the assembled prompt — feeds counter calibration (§2.4 / AGT-12). */
  promptChars: number;
  sections: { system: number; tools: number; summary: number; messages: number };
}

/**
 * Prepares the conversation context before calling the provider.
 * Enforces inputBudget and throws ERR_CONTEXT_OVERFLOW if it cannot fit (§2.4 / AGT-07).
 */
export function prepareContext(opts: {
  systemPrompt: string;
  tools: VirtualToolDef[];
  state: WorkflowState;
  history: ChatMessage[];
  budget?: BudgetConfig;
  counter?: TokenEstimator;
}): PreparedContext {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const counter = opts.counter ?? HEURISTIC_ESTIMATOR;

  const toolsJson = JSON.stringify(opts.tools);
  const sysTokens = counter.estimate(opts.systemPrompt);
  const toolTokens = counter.estimate(toolsJson);
  const summary = buildStateSummary(opts.state, counter);
  const summaryTokens = counter.estimate(summary);

  const fixedTokens = sysTokens + toolTokens + summaryTokens;
  if (fixedTokens > budget.inputBudget) {
    throw new AgentError(
      'ERR_CONTEXT_OVERFLOW',
      `Fixed prompt, tools, and state (${fixedTokens} tokens) exceed input budget (${budget.inputBudget} tokens)`,
    );
  }

  const remainingForMessages = budget.inputBudget - fixedTokens;

  // Tool results from the current and previous turn are compacted; older ones
  // collapse to a digest line. Turn boundaries are the plain user messages.
  const turnStarts: number[] = [];
  for (let i = 0; i < opts.history.length; i++) {
    const msg = opts.history[i];
    if (msg.role === 'user' && !msg.toolResults?.length) turnStarts.push(i);
  }
  const recentFrom = turnStarts.length >= 2 ? turnStarts[turnStarts.length - 2] : 0;

  const processedMessages: ChatMessage[] = [];
  for (let i = 0; i < opts.history.length; i++) {
    const msg = opts.history[i];
    if (msg.role === 'user' && msg.toolResults?.length) {
      const isRecent = i >= recentFrom;
      const compactedResults: ToolResultInfo[] = msg.toolResults.map(tr => ({
        id: tr.id,
        name: tr.name,
        ok: tr.ok,
        source: tr.source,
        // Recent results enter wrapped in the data boundary; older ones collapse to a
        // single digest line, which is already a marker and needs no envelope.
        result: isRecent
          ? wrapToolResult(tr.name, compactToolResult(tr.name, tr.result, counter), { ok: tr.ok, source: tr.source })
          : tr.result.startsWith('[tool_digest')
            ? tr.result
            : digestToolResult(tr.name, tr.result, tr.ok !== false),
      }));
      processedMessages.push({ role: 'user', content: msg.content, toolResults: compactedResults });
    } else {
      processedMessages.push(msg);
    }
  }

  // Sliding window: fit as many recent messages as possible, never splitting an exchange.
  let fittedMessages: ChatMessage[] = processedMessages;
  let currentMsgTokens = 0;

  for (let i = processedMessages.length - 1; i >= 0; i--) {
    const msg = processedMessages[i];
    const msgTokens = estimateMessageTokens(msg, counter);
    if (currentMsgTokens + msgTokens > remainingForMessages) {
      // Ensure we don't start mid-exchange (an assistant tool-call without its user toolResults)
      let startIdx = i + 1;
      while (
        startIdx < processedMessages.length &&
        processedMessages[startIdx].role === 'assistant' &&
        processedMessages[startIdx].toolCalls?.length
      ) {
        startIdx++;
        if (startIdx < processedMessages.length && processedMessages[startIdx].toolResults?.length) {
          startIdx++;
        }
      }
      fittedMessages = processedMessages.slice(startIdx);
      break;
    }
    currentMsgTokens += msgTokens;
  }

  if (fittedMessages.length === 0 && processedMessages.length > 0) {
    // The newest message alone does not fit: refuse the turn instead of calling the
    // provider with an empty conversation (§2.4 / AGT-07).
    throw new AgentError(
      'ERR_CONTEXT_OVERFLOW',
      `The latest message does not fit in the remaining input budget (${remainingForMessages} tokens)`,
    );
  }

  const messageTokens = fittedMessages.reduce((sum, m) => sum + estimateMessageTokens(m, counter), 0);
  const totalTokens = fixedTokens + messageTokens;

  if (totalTokens > budget.inputBudget) {
    throw new AgentError(
      'ERR_CONTEXT_OVERFLOW',
      `Prompt total (${totalTokens} tokens) exceeds input budget (${budget.inputBudget} tokens)`,
    );
  }

  const promptChars =
    opts.systemPrompt.length +
    toolsJson.length +
    summary.length +
    fittedMessages.reduce((sum, m) => sum + messageChars(m), 0);

  return {
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    stateSummary: summary,
    messages: fittedMessages,
    estimatedTokens: totalTokens,
    promptChars,
    sections: { system: sysTokens, tools: toolTokens, summary: summaryTokens, messages: messageTokens },
  };
}

function messageChars(msg: ChatMessage): number {
  let chars = msg.content.length;
  if (msg.toolCalls) chars += msg.toolCalls.reduce((a, tc) => a + tc.name.length + JSON.stringify(tc.args).length, 0);
  if (msg.toolResults) chars += msg.toolResults.reduce((a, tr) => a + tr.result.length, 0);
  return chars;
}

function estimateMessageTokens(msg: ChatMessage, counter: TokenEstimator = HEURISTIC_ESTIMATOR): number {
  return estimateChars(counter, messageChars(msg));
}
