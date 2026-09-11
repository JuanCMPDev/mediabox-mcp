/* ─── Agent Runtime Loop ───────────────────────────────────────────────────
 * Coordinates LLM inference, phases, context budget, dispatch, guards, and trace (§2.5 / AGT-01..12).
 *
 * Two invariants this file is responsible for:
 *  - The workflow state is persisted BEFORE any terminal event is yielded, because
 *    consumers stop reading at `guard`/`error` and code after a yield never runs.
 *  - The history never ends with an assistant tool-call message that has no results,
 *    which would make the next provider request malformed.
 * ──────────────────────────────────────────────────────────────────────── */
import { createHash } from 'node:crypto';
import type { ChatEvent, TypedSelection, Phase } from '@mediabox/contracts';
import type { StreamChatOptions, ChatMessage, ToolCallInfo, ToolResultInfo } from '../types.js';
import type { LLMStreamChunk } from '../providers/types.js';
import { AgentError } from './errors.js';
import {
  type WorkflowState,
  type WorkflowStore,
  type WorkflowIntent,
  type ClockFn,
  type CandidateRecord,
  defaultClock,
  createInitialWorkflowState,
  migrateWorkflowState,
  reduce,
  isValidMediaRef,
  isValidReleaseRef,
  InMemoryWorkflowStore,
} from './workflow.js';
import { getPhaseTools } from './phases.js';
import { buildSystemPromptForPhase } from '../prompt.js';
import { PRESENT_CHOICES_TOOL } from '../virtual-tools.js';
import { prepareContext, budgetForContext, digestToolResult, type BudgetConfig, DEFAULT_BUDGET } from './budget.js';
import { TurnGuards, type GuardConfig, computeArgsHash } from './guards.js';
import { dispatchToolCall } from './dispatch.js';
import { TokenCounter } from './tokenizer.js';
import { redactTrace, type AgentTrace, type InferenceTrace, type ToolCallTrace } from './trace.js';
import { heuristicPhase } from '../tool-selector.js';
import { trimHistory } from '../history.js';

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

/** Shared fallback store so a consumer without persistence can still be reset. */
export function getDefaultWorkflowStore(): InMemoryWorkflowStore {
  return DEFAULT_WORKFLOW_STORE;
}

/**
 * History retention. Results older than the last two turns are already collapsed to
 * a digest, so the only bulky entries are at most two raw result sets, each bounded
 * to DEFAULT_RESULT_BUDGET_BYTES (24 KB) by the MCP client. The floor keeps those
 * two sets plus the digest trail; the budget multiple covers larger windows.
 */
const HISTORY_RETENTION_FACTOR = 2;
const HISTORY_RETENTION_FLOOR_TOKENS = 28_000;

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

/**
 * Lexical intent classification for the turn. It only decides which phase the
 * turn starts from and which propose tool the phase offers; every permission
 * decision stays in code (§2.3).
 */
/**
 * Words that describe the action or the quality of a request rather than its
 * subject. Removing them is what makes "descarga la version 1080p" a refinement
 * of the current subject instead of a brand new request.
 */
const NON_SUBJECT_WORDS = new Set([
  'busca', 'buscar', 'buscame', 'encuentra', 'encontrar', 'search', 'find', 'show', 'muestra', 'muestrame',
  'descarga', 'descargar', 'descargame', 'baja', 'bajar', 'download', 'grab', 'agrega', 'agregar', 'add',
  'borra', 'borrar', 'elimina', 'eliminar', 'delete', 'remove', 'quita', 'quitar',
  'transcodifica', 'transcode', 'remux', 'convierte', 'convertir', 'convert', 'optimiza', 'optimize',
  'inspecciona', 'inspect', 'analiza', 'analyze', 'formato', 'format', 'codec',
  'pelicula', 'peliculas', 'movie', 'movies', 'serie', 'series', 'anime', 'show', 'shows', 'temporada',
  'season', 'episodio', 'episode', 'capitulo', 'version', 'versiones', 'calidad', 'quality', 'disponibles',
  'available', 'latino', 'latina', 'espanol', 'english', 'ingles', 'castellano', 'subtitulado', 'dual',
  'subtitulos', 'subtitles', 'audio', 'esta', 'este', 'esto',
  'este', 'tengo', 'hay', 'quiero', 'want', 'please', 'porfavor', 'ahora', 'now', 'todos', 'todas',
  'archivo', 'archivos', 'file', 'files', 'carpeta', 'folder', 'plan', 'estado', 'status',
]);

/** Subject words of a request: long enough, not a verb or a quality word. */
export function extractSubjects(message: string): string[] {
  const normalized = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  const subjects: string[] = [];
  for (const raw of normalized.split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (NON_SUBJECT_WORDS.has(raw)) continue;
    if (/^\d+p?$/.test(raw)) continue;          // 1080p, 720, 2160p
    if (/^(x264|x265|hevc|av1|hdr|bluray|webdl|web|dvdrip)$/.test(raw)) continue;
    if (!subjects.includes(raw)) subjects.push(raw);
  }
  return subjects.slice(0, 8);
}

export function classifyIntent(message: string): WorkflowIntent | undefined {
  const text = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  const summary = message.trim();
  const subjects = extractSubjects(message);
  if (/\b(borra\w*|borrar|elimina\w*|eliminar|delete|remove|quita\w*)\b/.test(text)) {
    return { kind: 'delete', summary, subjects };
  }
  if (/\b(transcod\w*|remux\w*|convert\w*|subtitul\w*|subtitle|optimiza\w*|optimize)\b/.test(text)) {
    return { kind: 'convert', summary, subjects };
  }
  if (/\b(inspeccion\w*|inspect|analiza\w*|analyze|ffprobe|formato|format|codec)\b/.test(text)) {
    return { kind: 'inspect', summary, subjects };
  }
  if (
    /\b(plan_[a-z0-9-]+|estado del plan|operation status|status of plan|progreso|progress)\b/.test(text) ||
    /\b(status|estado)\b[^.]{0,24}\b(plan|operacion|operation)\b/.test(text)
  ) {
    return { kind: 'status', summary, subjects };
  }
  if (/\b(descarga\w*|descargar|baja\w*|bajar|download|torrent|grab|agrega\w*|agregar|add)\b/.test(text)) {
    return { kind: 'download', summary, subjects };
  }
  if (/\b(busca\w*|buscar|encuentra\w*|find|search|tengo|hay|pelicula|movie|serie\w*|series|anime|show)\b/.test(text)) {
    return { kind: 'other', summary, subjects };
  }
  return undefined;
}

/**
 * Which virtual tool (and action) is entitled to mint which reference kind.
 * A reference appearing in the payload of any other tool is data, not a
 * reference, so it can never move the phase or unlock the propose catalog
 * (§2.7 / AGT-04).
 */
const REFERENCE_SOURCES: Record<string, { media?: string[]; release?: string[]; paths?: string[] }> = {
  catalog:      { media: ['search', 'details'], release: ['releases'] },
  media_query:  { media: ['search', 'details'] },
  series:       { release: ['releases'] },
  movies:       { release: ['releases'] },
  library_ops:  { paths: ['list'] },
  media_format: { paths: ['analyze'] },
};

function actionOf(args: Record<string, unknown>): string {
  return typeof args.action === 'string' ? args.action : '';
}

function collectRefStrings(value: unknown, key: 'mediaRef' | 'releaseRef', out: string[], depth = 0): void {
  if (out.length >= 4 || depth > 3 || !value) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) collectRefStrings(item, key, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const direct = record[key];
    if (typeof direct === 'string') out.push(direct);
    for (const nestedKey of ['data', 'items', 'results']) {
      if (record[nestedKey]) collectRefStrings(record[nestedKey], key, out, depth + 1);
    }
  }
}

function collectPaths(parsed: unknown, out: string[]): void {
  const record = parsed as Record<string, any> | null;
  if (!record) return;
  const data = record.data;
  const candidates = Array.isArray(data) ? data : data ? [data] : [];
  for (const item of candidates.slice(0, 20)) {
    const p = item?.path ?? item?.relativePath ?? item?.logicalPath;
    if (typeof p === 'string' && p.length > 0 && p.length <= 300) out.push(p);
  }
}

/** Extracts only the references this tool is entitled to produce. */
export function extractEntitledReferences(
  toolName: string,
  args: Record<string, unknown>,
  parsed: unknown,
): { mediaRef?: string; releaseRef?: string; paths?: string[] } | undefined {
  const entitlement = REFERENCE_SOURCES[toolName];
  if (!entitlement) return undefined;
  const action = actionOf(args);
  const refs: { mediaRef?: string; releaseRef?: string; paths?: string[] } = {};

  if (entitlement.media?.includes(action)) {
    const found: string[] = [];
    collectRefStrings(parsed, 'mediaRef', found);
    const valid = found.find(isValidMediaRef);
    if (valid) refs.mediaRef = valid.trim();
  }
  if (entitlement.release?.includes(action)) {
    const found: string[] = [];
    collectRefStrings(parsed, 'releaseRef', found);
    const valid = found.find(isValidReleaseRef);
    if (valid) refs.releaseRef = valid.trim();
  }
  if (entitlement.paths?.includes(action)) {
    const paths: string[] = [];
    collectPaths(parsed, paths);
    if (paths.length > 0) refs.paths = paths.slice(0, 20);
  }

  return Object.keys(refs).length > 0 ? refs : undefined;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** True when this virtual call is the one that creates a plan (§2.8). */
function isProposalCall(toolName: string, args: Record<string, unknown>): boolean {
  const action = actionOf(args);
  return (
    (toolName === 'catalog' && action === 'propose_download') ||
    (toolName === 'library_ops' && action === 'propose_delete') ||
    (toolName === 'media_format' && action === 'propose')
  );
}

/**
 * Collapses tool results older than the current and previous turn to their digest
 * inside the stored history. Keeping full payloads for the whole conversation is
 * what made the persisted history grow without bound, and they are never sent to
 * the model anyway (§2.4).
 */
export function collapseHistoryToolResults(history: ChatMessage[]): void {
  const turnStarts: number[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === 'user' && !msg.toolResults?.length) turnStarts.push(i);
  }
  if (turnStarts.length < 2) return;
  const recentFrom = turnStarts[turnStarts.length - 2];

  for (let i = 0; i < recentFrom; i++) {
    const msg = history[i];
    if (msg.role !== 'user' || !msg.toolResults?.length) continue;
    msg.toolResults = msg.toolResults.map(tr =>
      tr.result.startsWith('[tool_digest')
        ? tr
        : { ...tr, result: digestToolResult(tr.name, tr.result, tr.ok !== false) },
    );
  }
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
      clock = defaultClock,
      onTrace,
    } = opts;

    const budget =
      opts.budget ??
      (provider.contextTokens ? budgetForContext(provider.contextTokens) : DEFAULT_BUDGET);

    const fallbacks = pickFallbacks(locale);
    const startTime = Date.now();
    const guards = new TurnGuards(opts.guards, startTime);

    // 1. Initial conversation event
    yield { type: 'conversation', id: conversationId };

    // 2. Load, migrate or discard the workflow state (§2.2 / §6.11)
    let state: WorkflowState;
    const stateNotes: string[] = [];
    try {
      const stored = await workflowStore.get(conversationId);
      if (!stored) {
        state = createInitialWorkflowState(conversationId, principalId, installationId, clock);
      } else {
        const migrated = migrateWorkflowState(stored);
        if (!migrated) {
          const note = `ERR_WORKFLOW_CORRUPT: discarded state with unsupported schemaVersion ${(stored as any)?.schemaVersion}`;
          stateNotes.push(note);
          console.warn(`[agent] ${note} (conversation ${conversationId}); plans are untouched`);
          state = createInitialWorkflowState(conversationId, principalId, installationId, clock);
        } else {
          state = migrated.state;
          if (migrated.migratedFrom) {
            const note = `migrated workflow state from schemaVersion ${migrated.migratedFrom}`;
            stateNotes.push(note);
            console.warn(`[agent] ${note} (conversation ${conversationId})`);
          }
        }
      }
    } catch (err) {
      const note = `ERR_WORKFLOW_CORRUPT: ${err instanceof Error ? err.message : String(err)}`;
      stateNotes.push(note);
      console.warn(`[agent] ${note} (conversation ${conversationId}); starting a fresh state`);
      state = createInitialWorkflowState(conversationId, principalId, installationId, clock);
    }

    const initialPhase = state.phase;
    const history = historyStore.get(conversationId);
    const counter = TokenCounter.fromCalibration(state.calibration);

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
      const suggestedPhase: Phase = heuristicPhase(message, history);
      const intent = classifyIntent(message);

      const prevPhase = state.phase;
      state = reduce(state, { type: 'user_message', text: message, intent, suggestedPhase }, clock);
      if (state.phase !== prevPhase) {
        yield { type: 'phase', phase: state.phase, reason: 'user_message' };
      }
      history.push({ role: 'user', content: message });
      historyStore.set(conversationId, history);
    }

    // 4. Initialize trace (§2.10 / AGT-10). turnId is deterministic (§6.12).
    const trace: AgentTrace = {
      turnId: `turn_${state.turn + 1}_${shortHash(conversationId)}`,
      conversationId,
      provider: provider.providerName,
      model: provider.model,
      runtime: (provider as { runtime?: string }).runtime,
      initialPhase,
      finalPhase: state.phase,
      inferences: [],
      toolCalls: [],
      guardDecisions: [...stateNotes],
      budgetUsed: { inputEstimated: 0, outputReserve: budget.outputReserve },
      proposalKeys: [],
      createdAt: clock(),
    };

    let repairAttempted = false;
    let turnCompleted = false;

    // Pending tool calls announced to the provider but whose results are not yet
    // in the history. Any exit path must flush them (§2.5).
    let pendingCalls: ToolCallInfo[] | null = null;
    let pendingResults: ToolResultInfo[] = [];

    const persistHistory = (): void => {
      collapseHistoryToolResults(history);
      historyStore.set(
        conversationId,
        trimHistory(
          history,
          Math.max(budget.inputBudget * HISTORY_RETENTION_FACTOR, HISTORY_RETENTION_FLOOR_TOKENS),
        ),
      );
    };

    const flushPendingToolResults = (code: string, messageText: string): void => {
      if (!pendingCalls) return;
      const delivered = new Set(pendingResults.map(r => r.id));
      for (const call of pendingCalls) {
        if (delivered.has(call.id)) continue;
        pendingResults.push({
          id: call.id,
          name: call.name,
          ok: false,
          result: JSON.stringify({ status: 'error', error: { code, message: messageText } }),
        });
      }
      history.push({ role: 'user', content: '', toolResults: pendingResults });
      pendingCalls = null;
      pendingResults = [];
      persistHistory();
    };

    const persistState = (): Promise<void> | void => {
      state = reduce(state, { type: 'calibration', calibration: counter.calibration }, clock);
      state = reduce(
        state,
        {
          type: 'turn_ended',
          budgetSnapshot: {
            contextTokens: budget.contextTokens,
            inputUsed: trace.budgetUsed.inputEstimated,
            outputReserve: budget.outputReserve,
          },
        },
        clock,
      );
      return workflowStore.set(conversationId, state);
    };

    try {
      while (!turnCompleted) {
        if (signal?.aborted) {
          throw new AgentError('ERR_CANCELLED', 'Turn cancelled by caller');
        }

        guards.checkInferenceAllowed();

        const currentPhase = state.phase;
        const exposedTools = getPhaseTools(currentPhase, { intentKind: state.intent?.kind });
        const systemPrompt = buildSystemPromptForPhase(locale, currentPhase);

        // Enforce context budget (§2.4 / AGT-02 / AGT-07)
        const prepared = prepareContext({
          systemPrompt,
          tools: exposedTools,
          state,
          history,
          budget,
          counter,
        });

        trace.budgetUsed.inputEstimated = Math.max(
          trace.budgetUsed.inputEstimated,
          prepared.estimatedTokens,
        );
        trace.budgetUsed.inputBudget = budget.inputBudget;

        const combinedSystemPrompt = `${prepared.systemPrompt}\n\n${prepared.stateSummary}`;

        let accText = '';
        const accCalls: ToolCallInfo[] = [];
        const infT0 = Date.now();
        let ttftMs: number | undefined;
        let completionTokens: number | undefined;
        let realPromptTokens: number | undefined;

        const llmStream = provider.stream({
          systemPrompt: combinedSystemPrompt,
          messages: prepared.messages,
          tools: prepared.tools,
          signal,
          maxTokens: budget.outputReserve,
        }) as AsyncGenerator<LLMStreamChunk>;

        for await (const chunk of llmStream) {
          if (signal?.aborted) {
            throw new AgentError('ERR_CANCELLED', 'Turn cancelled during stream');
          }

          if (chunk.type === 'text') {
            if (chunk.text) {
              if (ttftMs === undefined) ttftMs = Date.now() - infT0;
              accText += chunk.text;
              yield { type: 'token', text: chunk.text };
            }
          } else if (chunk.type === 'tool_call') {
            accCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
          }

          const usage = 'usage' in chunk ? chunk.usage : undefined;
          if (usage?.prompt_tokens) {
            realPromptTokens = usage.prompt_tokens;
          }
          if (usage?.completion_tokens) {
            completionTokens = usage.completion_tokens;
          }
        }

        // Calibrate the counter with the real prompt size (§2.4 / AGT-12). The
        // adjusted factor and margin persist in the workflow for the next turn.
        if (realPromptTokens) {
          counter.calibrate(prepared.estimatedTokens, realPromptTokens, prepared.promptChars);
        }

        const infDuration = Date.now() - infT0;
        const infTrace: InferenceTrace = {
          step: trace.inferences.length + 1,
          estimatedPromptTokens: prepared.estimatedTokens,
          realPromptTokens: counter.lastRealPromptTokens,
          completionTokens,
          ttftMs,
          durationMs: infDuration,
          counterFactor: counter.currentFactor,
          counterExtraMargin: counter.currentExtraMargin,
        };
        trace.inferences.push(infTrace);

        guards.recordInference(accText, accCalls.length);

        // ── Handle Tool Calls ────────────────────────────────────────────────
        if (accCalls.length > 0) {
          // Check for present_choices (§2.5)
          const choicesCall = accCalls.find(c => c.name === PRESENT_CHOICES_TOOL);
          if (choicesCall) {
            const built = buildChoicesEvent(choicesCall.args);
            if (built) {
              yield built.event;
              state = reduce(state, { type: 'candidates_presented', candidates: built.candidates }, clock);
            }

            history.push({ role: 'assistant', content: accText, toolCalls: [choicesCall] });
            history.push({
              role: 'user',
              content: '',
              toolResults: [{
                id: choicesCall.id,
                name: choicesCall.name,
                ok: true,
                result: JSON.stringify({ presented: built ? built.candidates.length : 0 }),
              }],
            });
            persistHistory();

            await persistState();

            const finalText = accText || '';
            turnCompleted = true;
            yield { type: 'done', fullText: finalText };
            return;
          }

          // Save assistant intention turn
          history.push({ role: 'assistant', content: accText, toolCalls: accCalls });
          pendingCalls = accCalls;
          pendingResults = [];

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

          let hadInvalidArgs = false;

          // Execute calls sequentially
          for (const tc of uniqueCalls) {
            if (signal?.aborted) {
              throw new AgentError('ERR_CANCELLED', 'Turn cancelled before tool dispatch');
            }

            const argsHash = computeArgsHash(tc.args);
            guards.checkToolCallAllowed(tc.name, argsHash);

            yield { type: 'tool-start', name: tc.name, args: tc.args, callId: tc.id };

            const remaining = guards.remainingMs();
            const dispatchRes = await dispatchToolCall({
              toolName: tc.name,
              args: tc.args,
              exposedTools,
              mcpCall,
              timeoutMs: Math.max(5_000, Math.min(150_000, remaining)),
              signal,
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
              errorCode: dispatchRes.errorCode ?? (dispatchRes.ok ? undefined : 'ERR_TOOL_FAILURE'),
            };
            trace.toolCalls.push(callTrace);

            // The raw payload is stored; budget.ts compacts and wraps it at prompt
            // build time so the envelope is always well formed (§2.7).
            pendingResults.push({
              id: tc.id,
              name: tc.name,
              ok: dispatchRes.ok,
              source: dispatchRes.mcpTool,
              result: dispatchRes.result,
            });

            if (dispatchRes.rejected) {
              hadInvalidArgs = true;
            }

            let references: { mediaRef?: string; releaseRef?: string; paths?: string[] } | undefined;
            try {
              const parsed = JSON.parse(dispatchRes.result);
              references = extractEntitledReferences(tc.name, tc.args, parsed);

              const plan = (parsed?.planId ? parsed : parsed?.data?.planId ? parsed.data : undefined) as
                | Record<string, any>
                | undefined;

              if (plan) {
                if (isProposalCall(tc.name, tc.args)) {
                  // Only a proposal call creates a proposal record; a status read may
                  // update one it already knows, never invent one.
                  if (plan.status === 'awaiting_approval' || plan.status === 'planned') {
                    state = reduce(
                      state,
                      {
                        type: 'proposal_created',
                        planId: plan.planId,
                        operation: plan.operation || 'operation',
                        status: plan.status,
                        manifestHash: plan.manifestHash || '',
                        proposalKey: plan.proposalKey || plan.planId,
                      },
                      clock,
                    );
                    trace.proposalKeys.push(plan.proposalKey || plan.planId);
                  }
                } else if (typeof plan.status === 'string') {
                  state = reduce(state, { type: 'operation_status', planId: plan.planId, status: plan.status }, clock);
                }
              }
            } catch {
              // Non-JSON results are ignored for proposal and reference tracking
            }

            // recordToolCall can raise ERR_LOOP_DETECTED; the state update above and
            // the pending result are already registered, so the flush keeps history valid.
            guards.recordToolCall(tc.name, dispatchRes.argsHash, dispatchRes.resultDigest);

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

          history.push({ role: 'user', content: '', toolResults: pendingResults });
          pendingCalls = null;
          pendingResults = [];
          persistHistory();
          continue; // Next inference iteration with tool results fed back
        }

        // ── Final Natural Language Response ──────────────────────────────────
        const finalText = accText || fallbacks.empty;
        history.push({ role: 'assistant', content: finalText });
        persistHistory();

        await persistState();

        turnCompleted = true;
        yield { type: 'done', fullText: finalText };
        return;
      }
    } catch (err: any) {
      const code: string = err instanceof AgentError ? err.code : 'ERR_AGENT_FAILURE';
      const messageText = err instanceof Error ? err.message : String(err);

      // Keep the transcript valid and persist before any terminal event, because the
      // consumer stops reading here and nothing after the first yield would run.
      flushPendingToolResults(code, messageText);
      if (err instanceof AgentError) {
        trace.guardDecisions.push(`${code}: ${messageText}`);
      }
      try {
        await persistState();
      } catch (persistErr) {
        console.warn(
          `[agent] could not persist workflow state after ${code}: ${(persistErr as Error).message}`,
        );
      }

      if (err instanceof AgentError) {
        if (
          err.code === 'ERR_LOOP_DETECTED' ||
          err.code === 'ERR_TURN_BUDGET' ||
          err.code === 'ERR_CONTEXT_OVERFLOW' ||
          err.code === 'ERR_REPAIR_EXHAUSTED'
        ) {
          const userText = guardMessage(err.code, fallbacks, messageText);
          yield { type: 'guard', code: err.code, message: messageText };
          yield { type: 'done', fullText: `⚠ ${userText}` };
        } else {
          yield { type: 'error', code: err.code, message: messageText };
        }
      } else {
        yield { type: 'error', message: messageText };
      }
    } finally {
      trace.finalPhase = state.phase;
      trace.guardDecisions.push(...guards.decisions.filter(d => !trace.guardDecisions.includes(d)));
      trace.counterLogs = counter.logs;
      const cleanTrace = redactTrace(trace);
      if (onTrace) {
        onTrace(cleanTrace);
      }
    }
  }
}

function guardMessage(code: string, fallbacks: Fallbacks, detail: string): string {
  switch (code) {
    case 'ERR_LOOP_DETECTED':
      return fallbacks.loopDetected;
    case 'ERR_TURN_BUDGET':
      return fallbacks.iterLimit;
    case 'ERR_CONTEXT_OVERFLOW':
      return fallbacks.contextOverflow;
    default:
      return detail;
  }
}

const VALID_SELECTION_TYPES = new Set(['select_candidate', 'select_release', 'propose_download']);
const MAX_CHOICE_ITEMS = 8;
const MAX_CHOICE_LABEL = 160;
const MAX_CHOICE_TEXT = 240;

function buildChoicesEvent(
  args: Record<string, unknown>,
): { event: Extract<ChatEvent, { type: 'choices' }>; candidates: CandidateRecord[] } | null {
  const rawItems = Array.isArray(args.items) ? args.items.slice(0, MAX_CHOICE_ITEMS) : [];
  const items: import('@mediabox/contracts').ChatChoiceItem[] = [];
  const candidates: CandidateRecord[] = [];

  for (const [i, raw] of rawItems.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const label = typeof r.label === 'string' ? sanitizeString(r.label, MAX_CHOICE_LABEL) : '';
    const value = typeof r.value === 'string' ? sanitizeString(r.value, MAX_CHOICE_TEXT) : '';
    if (!label || !value) continue;

    const mediaRef = isValidMediaRef(typeof r.mediaRef === 'string' ? r.mediaRef.trim() : undefined)
      ? (r.mediaRef as string).trim()
      : undefined;
    const releaseRef = isValidReleaseRef(typeof r.releaseRef === 'string' ? r.releaseRef.trim() : undefined)
      ? (r.releaseRef as string).trim()
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
      subtitle: typeof r.subtitle === 'string' ? sanitizeString(r.subtitle, MAX_CHOICE_TEXT) : undefined,
      meta: typeof r.meta === 'string' ? sanitizeString(r.meta, MAX_CHOICE_TEXT) : undefined,
      ...(selection ? { selection } : {}),
    });

    candidates.push({ label, ...(mediaRef ? { mediaRef } : {}), ...(releaseRef ? { releaseRef } : {}) });
  }

  if (items.length === 0) return null;
  const prompt = typeof args.prompt === 'string' ? sanitizeString(args.prompt, MAX_CHOICE_TEXT) : undefined;
  return { event: { type: 'choices', prompt, items }, candidates };
}

function sanitizeString(str: string, maxLen = MAX_CHOICE_TEXT): string {
  // Strip control characters and bound the length (§2.7 / §6.13)
  const clean = str.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}
