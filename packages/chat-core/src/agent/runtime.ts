/* ─── Agent Runtime Loop ───────────────────────────────────────────────────
 * Coordinates LLM inference, phases, context budget, dispatch, guards, and trace (§2.5 / AGT-01..12).
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatEvent, TypedSelection, Phase } from '@mediabox/contracts';
import type { StreamChatOptions, ChatMessage, ToolCallInfo, ToolResultInfo, McpCallFn, HistoryStore } from '../types.js';
import type { StreamProvider, LLMStreamChunk } from '../providers/types.js';
import { AgentError } from './errors.js';
import {
  type WorkflowState,
  type WorkflowStore,
  type ClockFn,
  defaultClock,
  createInitialWorkflowState,
  reduce,
  InMemoryWorkflowStore,
} from './workflow.js';
import { getPhaseTools } from './phases.js';
import { buildSystemPromptForPhase } from '../prompt.js';
import { PRESENT_CHOICES_TOOL } from '../virtual-tools.js';
import { prepareContext, type BudgetConfig, DEFAULT_BUDGET } from './budget.js';
import { TurnGuards, type GuardConfig, computeArgsHash } from './guards.js';
import { dispatchToolCall } from './dispatch.js';
import { TokenCounter } from './tokenizer.js';
import { redactTrace, type AgentTrace, type InferenceTrace, type ToolCallTrace } from './trace.js';
import { heuristicPhase } from '../tool-selector.js';

export interface AgentRuntimeOptions extends StreamChatOptions {
  principalId?: string;
  installationId?: string;
  workflowStore?: WorkflowStore;
  selection?: TypedSelection;
  budget?: BudgetConfig;
  guards?: Partial<GuardConfig>;
  clock?: ClockFn;
  onTrace?: (trace: AgentTrace) => void;
}

const DEFAULT_WORKFLOW_STORE = new InMemoryWorkflowStore();

interface Fallbacks {
  empty: string;
  iterLimit: string;
  loopDetected: string;
  contextOverflow: string;
}

const FALLBACKS: Record<'en' | 'es', Fallbacks> = {
  en: {
    empty: '(no response)',
    iterLimit: 'Iteration limit reached. Start a new conversation.',
    loopDetected: 'Execution stopped: repetitive actions detected without progress.',
    contextOverflow: 'Context limit exceeded. Please start a new conversation.',
  },
  es: {
    empty: '(sin respuesta)',
    iterLimit: 'Límite de iteraciones alcanzado. Inicia una nueva conversación.',
    loopDetected: 'Ejecución detenida: se detectaron acciones repetitivas sin progreso.',
    contextOverflow: 'Límite de contexto excedido. Por favor inicia una nueva conversación.',
  },
};

function pickFallbacks(locale?: string): Fallbacks {
  return locale === 'es' ? FALLBACKS.es : FALLBACKS.en;
}

export class AgentRuntime {
  /**
   * Executes a full streaming agent turn.
   */
  static async *streamTurn(opts: AgentRuntimeOptions): AsyncGenerator<ChatEvent> {
    const {
      conversationId,
      principalId = 'system',
      installationId = 'local',
      message = '',
      selection,
      provider,
      mcpCall,
      historyStore,
      workflowStore = DEFAULT_WORKFLOW_STORE,
      locale = 'en',
      signal,
      budget = DEFAULT_BUDGET,
      clock = defaultClock,
      onTrace,
    } = opts;

    const fallbacks = pickFallbacks(locale);
    const startTime = Date.now();
    const guards = new TurnGuards(opts.guards, startTime);
    const tokenizer = new TokenCounter();

    // 1. Initial conversation event
    yield { type: 'conversation', id: conversationId };

    // 2. Load or initialize workflow state (§2.2)
    let state: WorkflowState;
    try {
      const stored = await workflowStore.get(conversationId);
      if (stored && stored.schemaVersion === 1) {
        state = stored;
      } else {
        state = createInitialWorkflowState(conversationId, principalId, installationId, clock);
      }
    } catch {
      state = createInitialWorkflowState(conversationId, principalId, installationId, clock);
    }

    const initialPhase = state.phase;
    const history = historyStore.get(conversationId);

    // 3. Process turn input (typed_selection vs user_message)
    if (selection) {
      const prevPhase = state.phase;
      state = reduce(state, { type: 'typed_selection', selection }, clock);
      if (state.phase !== prevPhase) {
        yield { type: 'phase', phase: state.phase, reason: 'typed_selection' };
      }
      history.push({ role: 'user', content: selection.value || message || `[selection: ${selection.type}]` });
      historyStore.set(conversationId, history);
    } else if (message) {
      const suggested = heuristicPhase(message, history);
      let intentKind: 'download' | 'delete' | 'convert' | 'inspect' | 'status' | 'other' = 'other';
      if (suggested === 'discover') intentKind = 'download';
      else if (suggested === 'maintain') intentKind = 'other';

      const prevPhase = state.phase;
      state = reduce(
        state,
        {
          type: 'user_message',
          text: message,
          intent: suggested !== 'orient' ? { kind: intentKind, summary: message } : undefined,
        },
        clock,
      );
      if (state.phase !== prevPhase) {
        yield { type: 'phase', phase: state.phase, reason: 'user_message' };
      }
      history.push({ role: 'user', content: message });
      historyStore.set(conversationId, history);
    }

    // 4. Initialize trace (§2.10 / AGT-10)
    const trace: AgentTrace = {
      turnId: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      provider: provider.providerName,
      model: provider.model,
      initialPhase,
      finalPhase: state.phase,
      inferences: [],
      toolCalls: [],
      guardDecisions: [],
      budgetUsed: { inputEstimated: 0, outputReserve: budget.outputReserve },
      proposalKeys: [],
      createdAt: clock(),
    };

    let repairAttempted = false;
    let turnCompleted = false;

    try {
      while (!turnCompleted) {
        if (signal?.aborted) {
          throw new AgentError('ERR_CANCELLED', 'Turn cancelled by caller');
        }

        guards.checkInferenceAllowed();

        const currentPhase = state.phase;
        const exposedTools = getPhaseTools(currentPhase);
        const systemPrompt = buildSystemPromptForPhase(locale, currentPhase);

        // Enforce context budget (§2.4 / AGT-02 / AGT-07)
        const prepared = prepareContext({
          systemPrompt,
          tools: exposedTools,
          state,
          history,
          budget,
        });

        trace.budgetUsed.inputEstimated = Math.max(
          trace.budgetUsed.inputEstimated,
          prepared.estimatedTokens,
        );

        const combinedSystemPrompt = `${prepared.systemPrompt}\n\n${prepared.stateSummary}`;

        let accText = '';
        const accCalls: ToolCallInfo[] = [];
        const infT0 = Date.now();
        let ttftMs: number | undefined;
        let completionTokens: number | undefined;

        const llmStream = provider.stream({
          systemPrompt: combinedSystemPrompt,
          messages: prepared.messages,
          tools: prepared.tools,
        }) as AsyncGenerator<LLMStreamChunk>;

        for await (const chunk of llmStream) {
          if (signal?.aborted) {
            throw new AgentError('ERR_CANCELLED', 'Turn cancelled during stream');
          }

          if (chunk.type === 'text') {
            if (ttftMs === undefined) ttftMs = Date.now() - infT0;
            accText += chunk.text;
            yield { type: 'token', text: chunk.text };
          } else if (chunk.type === 'tool_call') {
            accCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
          }

          const usage = 'usage' in chunk ? chunk.usage : undefined;
          if (usage?.prompt_tokens) {
            tokenizer.calibrate(prepared.estimatedTokens, usage.prompt_tokens);
          }
          if (usage?.completion_tokens) {
            completionTokens = usage.completion_tokens;
          }
        }

        const infDuration = Date.now() - infT0;
        const infTrace: InferenceTrace = {
          step: trace.inferences.length + 1,
          estimatedPromptTokens: prepared.estimatedTokens,
          realPromptTokens: tokenizer.lastRealPromptTokens,
          completionTokens,
          ttftMs,
          durationMs: infDuration,
        };
        trace.inferences.push(infTrace);

        guards.recordInference(accText, accCalls.length);

        // ── Handle Tool Calls ────────────────────────────────────────────────
        if (accCalls.length > 0) {
          // Check for present_choices (§2.5)
          const choicesCall = accCalls.find(c => c.name === PRESENT_CHOICES_TOOL);
          if (choicesCall) {
            const choicesEvent = buildChoicesEvent(choicesCall.args);
            if (choicesEvent) yield choicesEvent;

            const stubCall: ToolCallInfo = {
              id: choicesCall.id,
              name: choicesCall.name,
              args: choicesCall.args,
            };
            history.push({ role: 'assistant', content: accText, toolCalls: [stubCall] });
            history.push({
              role: 'user',
              content: '',
              toolResults: [{ id: choicesCall.id, name: choicesCall.name, result: '{"presented":true}' }],
            });
            historyStore.set(conversationId, history);

            state = reduce(
              state,
              {
                type: 'turn_ended',
                budgetSnapshot: {
                  contextTokens: budget.contextTokens,
                  inputUsed: prepared.estimatedTokens,
                  outputReserve: budget.outputReserve,
                },
              },
              clock,
            );
            await workflowStore.set(conversationId, state);

            const finalText = accText || '';
            yield { type: 'done', fullText: finalText };
            turnCompleted = true;
            return;
          }

          // Save assistant intention turn
          history.push({ role: 'assistant', content: accText, toolCalls: accCalls });

          // Deduplicate identical calls within the same batch (tool + argsHash) (§2.5)
          const uniqueCalls: ToolCallInfo[] = [];
          const seenBatchHashes = new Set<string>();
          for (const call of accCalls) {
            const key = `${call.name}:${computeArgsHash(call.args)}`;
            if (!seenBatchHashes.has(key)) {
              seenBatchHashes.add(key);
              uniqueCalls.push(call);
            }
          }

          const results: ToolResultInfo[] = [];
          let hadInvalidArgs = false;

          // Execute calls sequentially
          for (const tc of uniqueCalls) {
            if (signal?.aborted) {
              throw new AgentError('ERR_CANCELLED', 'Turn cancelled before tool dispatch');
            }

            const argsHash = computeArgsHash(tc.args);
            guards.checkToolCallAllowed(tc.name, argsHash);

            yield { type: 'tool-start', name: tc.name, args: tc.args, callId: tc.id };

            const dispatchRes = await dispatchToolCall({
              toolName: tc.name,
              args: tc.args,
              exposedTools,
              mcpCall,
              timeoutMs: guards.stats.elapsedMs < 120_000 ? 150_000 : 30_000,
            });

            yield {
              type: 'tool-end',
              name: tc.name,
              ok: dispatchRes.ok,
              durationMs: dispatchRes.durationMs,
              callId: tc.id,
              ...(dispatchRes.ok ? {} : { error: dispatchRes.errorMessage }),
            };

            const callTrace: ToolCallTrace = {
              tool: tc.name,
              ok: dispatchRes.ok,
              durationMs: dispatchRes.durationMs,
              errorCode: dispatchRes.rejected ? 'ERR_ARGS_INVALID' : (dispatchRes.ok ? undefined : 'ERR_TOOL_FAILURE'),
            };
            trace.toolCalls.push(callTrace);

            guards.recordToolCall(tc.name, dispatchRes.argsHash, dispatchRes.resultDigest);

            // Proposal extraction for state update
            let references: { mediaRef?: string; releaseRef?: string } | undefined;
            try {
              const parsed = JSON.parse(dispatchRes.result);
              if (parsed.mediaRef) references = { ...references, mediaRef: parsed.mediaRef };
              if (parsed.releaseRef) references = { ...references, releaseRef: parsed.releaseRef };

              if (Array.isArray(parsed.data) && parsed.data.length > 0) {
                const first = parsed.data[0];
                if (first?.mediaRef) references = { ...references, mediaRef: first.mediaRef };
                if (first?.releaseRef) references = { ...references, releaseRef: first.releaseRef };
              } else if (parsed.data && typeof parsed.data === 'object') {
                if (parsed.data.mediaRef) references = { ...references, mediaRef: parsed.data.mediaRef };
                if (parsed.data.releaseRef) references = { ...references, releaseRef: parsed.data.releaseRef };
              }

              if (parsed.planId && (parsed.status === 'awaiting_approval' || parsed.status === 'planned')) {
                state = reduce(
                  state,
                  {
                    type: 'proposal_created',
                    planId: parsed.planId,
                    operation: parsed.operation || 'operation',
                    status: parsed.status,
                    manifestHash: parsed.manifestHash || '',
                    proposalKey: parsed.proposalKey || parsed.planId,
                  },
                  clock,
                );
                trace.proposalKeys.push(parsed.proposalKey || parsed.planId);
              }
            } catch {
              // Non-JSON results are ignored for proposal tracking
            }

            const prevPhase = state.phase;
            state = reduce(
              state,
              {
                type: 'tool_result',
                tool: tc.name,
                argsHash: dispatchRes.argsHash,
                resultDigest: dispatchRes.resultDigest,
                references,
              },
              clock,
            );

            if (state.phase !== prevPhase) {
              yield { type: 'phase', phase: state.phase, reason: `tool_result:${tc.name}` };
            }

            if (dispatchRes.rejected) {
              hadInvalidArgs = true;
            }

            // Wrap result per §2.7 defense against data instruction injection
            const wrappedResult = `[tool_result tool=${tc.name} status=${dispatchRes.ok ? 'ok' : 'error'}]\n${dispatchRes.result}\n[/tool_result]`;
            results.push({ id: tc.id, name: tc.name, result: wrappedResult });
          }

          // Single repair enforcement (§2.5)
          if (hadInvalidArgs) {
            if (repairAttempted) {
              throw new AgentError(
                'ERR_REPAIR_EXHAUSTED',
                'Single repair limit exceeded after consecutive invalid tool arguments',
              );
            }
            repairAttempted = true;
          }

          if (signal?.aborted) {
            throw new AgentError('ERR_CANCELLED', 'Turn cancelled during tool execution');
          }

          history.push({ role: 'user', content: '', toolResults: results });
          historyStore.set(conversationId, history);
          continue; // Next inference iteration with tool results fed back
        }

        // ── Final Natural Language Response ──────────────────────────────────
        const finalText = accText || fallbacks.empty;
        history.push({ role: 'assistant', content: finalText });
        historyStore.set(conversationId, history);

        state = reduce(
          state,
          {
            type: 'turn_ended',
            budgetSnapshot: {
              contextTokens: budget.contextTokens,
              inputUsed: prepared.estimatedTokens,
              outputReserve: budget.outputReserve,
            },
          },
          clock,
        );
        await workflowStore.set(conversationId, state);

        yield { type: 'done', fullText: finalText };
        turnCompleted = true;
        return;
      }
    } catch (err: any) {
      if (err instanceof AgentError) {
        if (
          err.code === 'ERR_LOOP_DETECTED' ||
          err.code === 'ERR_TURN_BUDGET' ||
          err.code === 'ERR_CONTEXT_OVERFLOW' ||
          err.code === 'ERR_REPAIR_EXHAUSTED'
        ) {
          yield { type: 'guard', code: err.code, message: err.message };
          yield { type: 'done', fullText: `⚠ ${err.message}` };
        } else {
          yield { type: 'error', code: err.code, message: err.message };
        }
      } else {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      }

      // Persist state before exit even on error
      state = reduce(state, { type: 'turn_ended' }, clock);
      await workflowStore.set(conversationId, state);
    } finally {
      trace.finalPhase = state.phase;
      const cleanTrace = redactTrace(trace);
      if (onTrace) {
        onTrace(cleanTrace);
      }
    }
  }
}

const VALID_SELECTION_TYPES = new Set(['select_candidate', 'select_release', 'propose_download']);

function buildChoicesEvent(args: Record<string, unknown>): Extract<ChatEvent, { type: 'choices' }> | null {
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const items: import('@mediabox/contracts').ChatChoiceItem[] = [];

  for (const [i, raw] of rawItems.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const label = typeof r.label === 'string' ? sanitizeString(r.label) : '';
    const value = typeof r.value === 'string' ? sanitizeString(r.value) : '';
    if (!label || !value) continue;

    const mediaRef = typeof r.mediaRef === 'string' && /^[mr]ref_/.test(r.mediaRef.trim())
      ? r.mediaRef.trim()
      : undefined;
    const releaseRef = typeof r.releaseRef === 'string' && /^rref_/.test(r.releaseRef.trim())
      ? r.releaseRef.trim()
      : undefined;

    let selection: TypedSelection | undefined;
    if (mediaRef || releaseRef) {
      let type: TypedSelection['type'];
      const rawType = typeof r.selectionType === 'string' ? r.selectionType.trim() : '';
      if (VALID_SELECTION_TYPES.has(rawType)) {
        type = rawType as TypedSelection['type'];
      } else if (releaseRef) {
        type = 'select_release';
      } else {
        type = 'select_candidate';
      }
      selection = {
        type,
        value,
        ...(mediaRef ? { mediaRef } : {}),
        ...(releaseRef ? { releaseRef } : {}),
      };
    }

    items.push({
      id: `c-${i}`,
      label,
      value,
      subtitle: typeof r.subtitle === 'string' ? sanitizeString(r.subtitle) : undefined,
      meta: typeof r.meta === 'string' ? sanitizeString(r.meta) : undefined,
      ...(selection ? { selection } : {}),
    });
  }

  if (items.length === 0) return null;
  const prompt = typeof args.prompt === 'string' ? sanitizeString(args.prompt) : undefined;
  return { type: 'choices', prompt, items };
}

function sanitizeString(str: string): string {
  // Strip control characters (§2.7)
  return str.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
}
