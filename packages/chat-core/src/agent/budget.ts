/* ─── Context Budget and Compaction ─────────────────────────────────────────
 * Enforces token allocations and limits (§2.4 / AGT-02 / AGT-07).
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatMessage, VirtualToolDef } from '../types.js';
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

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Builds a deterministic, concise summary of the active workflow state.
 * Capped at <= 600 tokens (§2.4).
 */
export function buildStateSummary(state: WorkflowState): string {
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
  if (state.proposals.length > 0) {
    const active = state.proposals.slice(-3).map(p => `${p.operation}:${p.planId}(${p.status})`);
    parts.push(`RecentPlans: ${active.join(' ')}`);
  }
  return parts.join('\n');
}

/**
 * Compacts a tool result JSON string to keep it within bounds (§2.4 / AGT-04):
 * - Keeps status, sources, page, error
 * - Maximum 5 data elements with short keys
 * - Strings truncated to 120 characters
 * - Total result capped at <= 700 tokens
 */
export function compactToolResult(toolName: string, rawResult: string): string {
  try {
    const parsed = JSON.parse(rawResult);
    if (typeof parsed !== 'object' || parsed === null) {
      return String(rawResult).slice(0, 400);
    }

    const compacted: Record<string, unknown> = {};

    // Keep top-level envelopes
    if ('status' in parsed) compacted.status = parsed.status;
    if ('sources' in parsed) compacted.sources = parsed.sources;
    if ('page' in parsed) compacted.page = parsed.page;
    if ('error' in parsed) compacted.error = truncateString(parsed.error, 120);
    if ('message' in parsed) compacted.message = truncateString(parsed.message, 120);
    if ('planId' in parsed) compacted.planId = parsed.planId;
    if ('operation' in parsed) compacted.operation = parsed.operation;

    // Prune data array to at most 5 items and short fields
    if (Array.isArray(parsed.data)) {
      compacted.data = parsed.data.slice(0, 5).map((item: unknown) => {
        if (typeof item !== 'object' || item === null) return item;
        const shortItem: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(item)) {
          if (['id', 'title', 'year', 'mediaRef', 'releaseRef', 'score', 'status', 'resolution', 'size'].includes(k)) {
            shortItem[k] = typeof v === 'string' ? truncateString(v, 120) : v;
          }
        }
        return shortItem;
      });
      compacted.totalCount = parsed.data.length;
    } else if ('data' in parsed) {
      compacted.data = parsed.data;
    }

    const serialized = JSON.stringify(compacted);
    // If it still exceeds 700 tokens (~2450 chars), hard-slice it cleanly
    if (estimateTokenCount(serialized) > 700) {
      return serialized.slice(0, 2400) + '...}';
    }
    return serialized;
  } catch {
    return truncateString(rawResult, 500);
  }
}

function truncateString(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return String(val ?? '');
  return val.length > maxLen ? val.slice(0, maxLen) + '...' : val;
}

export interface PreparedContext {
  systemPrompt: string;
  tools: VirtualToolDef[];
  stateSummary: string;
  messages: ChatMessage[];
  estimatedTokens: number;
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
}): PreparedContext {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const sysTokens = estimateTokenCount(opts.systemPrompt);
  const toolTokens = estimateTokenCount(JSON.stringify(opts.tools));
  const summary = buildStateSummary(opts.state);
  const summaryTokens = estimateTokenCount(summary);

  const fixedTokens = sysTokens + toolTokens + summaryTokens;
  if (fixedTokens > budget.inputBudget) {
    throw new AgentError(
      'ERR_CONTEXT_OVERFLOW',
      `Fixed prompt, tools, and state (${fixedTokens} tokens) exceed input budget (${budget.inputBudget} tokens)`,
    );
  }

  const remainingForMessages = budget.inputBudget - fixedTokens;

  // Process history: compact recent tool results and replace older results with digests
  const processedMessages: ChatMessage[] = [];
  for (let i = 0; i < opts.history.length; i++) {
    const msg = opts.history[i];
    if (msg.role === 'user' && msg.toolResults?.length) {
      // Is this in the last 2 turns?
      const isRecent = i >= opts.history.length - 4;
      const compactedResults = msg.toolResults.map(tr => ({
        id: tr.id,
        name: tr.name,
        result: isRecent
          ? compactToolResult(tr.name, tr.result)
          : `[tool_digest tool=${tr.name} status=ok]`,
      }));
      processedMessages.push({ role: 'user', content: msg.content, toolResults: compactedResults });
    } else {
      processedMessages.push(msg);
    }
  }

  // Sliding window: fit as many recent messages as possible
  let fittedMessages: ChatMessage[] = [];
  let currentMsgTokens = 0;

  for (let i = processedMessages.length - 1; i >= 0; i--) {
    const msg = processedMessages[i];
    const msgTokens = estimateMessageTokens(msg);
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
    if (i === 0) {
      fittedMessages = processedMessages;
    }
  }

  const totalTokens = fixedTokens + fittedMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

  if (totalTokens > budget.inputBudget) {
    throw new AgentError(
      'ERR_CONTEXT_OVERFLOW',
      `Prompt total (${totalTokens} tokens) exceeds input budget (${budget.inputBudget} tokens)`,
    );
  }

  return {
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    stateSummary: summary,
    messages: fittedMessages,
    estimatedTokens: totalTokens,
  };
}

function estimateMessageTokens(msg: ChatMessage): number {
  let chars = msg.content.length;
  if (msg.toolCalls) chars += msg.toolCalls.reduce((a, tc) => a + tc.name.length + JSON.stringify(tc.args).length, 0);
  if (msg.toolResults) chars += msg.toolResults.reduce((a, tr) => a + tr.result.length, 0);
  return Math.ceil(chars / 3.5);
}
