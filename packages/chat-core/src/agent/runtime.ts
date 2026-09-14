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
  type WorkflowReferences,
  type ClockFn,
  type CandidateRecord,
  defaultClock,
  createInitialWorkflowState,
  migrateWorkflowState,
  reduce,
  isValidMediaRef,
  isValidReleaseRef,
  InMemoryWorkflowStore,
  READ_INTENTS,
  REFERENCE_LIMITS,
  canonicalPathKey,
  type IntentKind,
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
  // Words of reads and follow-ups: they never name what the request is about.
  'descargas', 'descargado', 'descargados', 'descargada', 'descargadas', 'descargo', 'descargando',
  'descargala', 'descargalo', 'descargarla', 'descargarlo', 'downloads', 'downloading', 'downloaded',
  'cola', 'queue', 'curso', 'progreso', 'progress', 'mismo', 'cuanto', 'cuanta', 'cuantos', 'cuantas',
  'episodios', 'episodes', 'temporadas', 'seasons', 'capitulos', 'pistas', 'tracks', 'subtitulo',
  'which', 'what', 'have', 'many', 'much', 'alguien', 'viendo', 'watching', 'espacio', 'libre',
  'disco', 'servidor', 'server', 'biblioteca', 'library', 'jellyfin', 'total', 'resumen', 'cual',
  'cuales', 'tiene', 'tienen', 'completas', 'incompletas', 'termino', 'terminado', 'aprobe', 'aprobado',
  'puedo', 'verla', 'verlo', 'dame', 'dime', 'como', 'donde', 'cuando', 'quien', 'para', 'sobre',
  'desde', 'hasta', 'otra', 'otro', 'otras', 'otros', 'tambien', 'solo', 'pero', 'with', 'from',
  'that', 'this', 'these', 'those', 'there', 'your', 'about', 'only', 'also', 'again', 'another',
  'release', 'releases', 'resolucion', 'resolution', 'idioma', 'language', 'catalogo', 'catalog',
  'conviertela', 'conviertelo', 'propon', 'proponer', 'propose', 'analizar', 'inspeccionar',
  'restaura', 'restaurar', 'restore', 'cuarentena', 'quarantine', 'definitivamente', 'aprueba',
  'approve', 'mueve', 'mover', 'move', 'doing', 'going',
  // Fillers of a follow-up ("ok, download it"): never a new subject.
  'vale', 'okay', 'bueno', 'venga', 'perfecto', 'genial', 'claro', 'gracias', 'thanks', 'sure',
  'great', 'then', 'entonces', 'luego', 'listo',
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

/* Lexical cues of classifyIntent, over lower-case text without accents. The order
 * of the checks in classifyIntent is part of its contract (intent-corpus.test.ts). */
const OWNER_ONLY_CUE = /\b(restaur\w*|restore\w*|purg\w*|aprueb\w*|aprobar|approve|authori[sz]e|autoriz\w*)\b/;
const QUARANTINE_CUE = /\b(cuarentena|quarantine\w*)\b/;
const PERMANENT_CUE = /\b(definitiv\w*|permanent\w*|vacia\w*|vaciar|empty)\b/;
const PLAN_ID_CUE = /\bplan_[a-z0-9-]+/;
const PLAN_CUE = /\b(plan|planes|operacion|operaciones|operation|operations|propuesta|propuestas|proposal|proposals)\b/;
const PLAN_STATE_CUE = /\b(estado|status|progreso|progress|termin\w*|finish\w*|complet\w*|quedo|result\w*|aprobad\w*|rechazad\w*|approved|rejected|va|going|how|como|que paso|what happened)\b/;
const DOWNLOAD_OUTCOME_CUE = /\b(se (ha |han )?descarg(o|ado|ada|ados|adas|aron)|ya (se )?(puedo|puede|podemos|pueden) ver|ya esta disponible|(termino|acabo|completo|finalizo) la descarga|(como|cuando) termino|downloaded yet|finished downloading|is it (ready|available)|can i (watch|see) it)\b/;
const QUEUE_SUBJECT_CUE = /\b(cola|colas|queue|queues|descarga|descargas|descargando|download|downloads|downloading|torrent|torrents|qbittorrent|qbit)\b/;
const QUEUE_QUESTION_CUE = /\b(que|cual|cuales|cuant\w*|como|what|which|how|estado|status|progreso|progress|curso|activas?|active|pendientes?|pending|lista\w*|list|muestra\w*|show|ver|check|revisa\w*|hay|current|now|ahora)\b/;
const DOWNLOAD_COMMAND_CUE = /^(?:(?:por favor|please|oye|hey)[\s,]+)?(?:descarga(?:me|la|lo|las|los|r)?|baja(?:me|la|lo|r)?|download|grab|quiero descargar|i want to download|can you download|puedes descargar)\b/;
const CONVERT_CUE = /\b(transcod\w*|remux\w*|convert\w*|conviert\w*|convirt\w*|optimiz\w*|recodific\w*|reencod\w*|encode)\b/;
const MAINTENANCE_CUE = /\b(mantenimiento|maintenance|limpieza|limpia\w*|limpiar|cleanup|clean up|huerfan\w*|orphans?|temporales|cache|caches|jobs?|background)\b/;
const DELETE_CUE = /\b(borra\w*|borrar|elimina\w*|eliminar|delete|remove|quita\w*|quitar|suprim\w*)\b/;
const INSPECT_CUE = /\b(inspecciona\w*|inspect\w*|analiza\w*|analyze|analyse|ffprobe|codecs?|pistas?|tracks?|streams?|bitrate|formato|format)\b/;
const DOWNLOAD_CUE = /\b(descarga|descargar|descargame|descargala|descargalo|descargalas|descargalos|descargarla|descargarlo|descargarlas|descargarlos|baja|bajar|bajame|bajala|bajalo|download|grab|consigue\w*|conseguir|agrega\w*|agregar|anade\w*|anadir|add)\b/;
const SEARCH_CUE = /\b(busca\w*|buscar|encuentra\w*|encontrar|find|search\w*|look up|lookup|releases?|versiones)\b/;
const SERVER_CUE = /\b(servidor|server|salud|health|cpu|ram|memoria|memory|espacio|space|almacenamiento|storage|sesion\w*|sessions?|viendo|watching|reproduc\w*|playing|playback|actividad|activity|historial|history|usuarios?|users?|uptime)\b/;
const MEDIA_NOUN_CUE = /\b(peliculas?|movies?|films?|series|serie|shows?|episodios?|episodes?|capitulos?|temporadas?|seasons?|anime|biblioteca|library|coleccion|collection|jellyfin)\b/;
const POSSESSION_CUE = /\b(tengo|tenemos|tienes|have|own|owned|descargad\w*|downloaded|on disk|en disco|en mi biblioteca|in my library|en jellyfin|in jellyfin)\b/;
const LIST_CUE = /\b(cuant\w*|how many|lista\w*|list|todas|todos|all|resumen|summary|total)\b/;
const WHICH_MEDIA_CUE = /\b(que|cuales|which|what)\s+(peliculas|series|episodios|temporadas|capitulos|movies|films|shows|episodes|seasons)\b/;
const NUMBERED_ITEM_CUE = /\b(episodio|episode|capitulo|temporada|season)\s*\d+/;

export function classifyIntent(message: string): WorkflowIntent | undefined {
  const text = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  const summary = message.trim();
  const subjects = extractSubjects(message);
  const intent = (kind: IntentKind): WorkflowIntent => ({ kind, summary, subjects });
  // Imperatives are recognised at the start, after polite words and punctuation.
  const opening = text.replace(/^[^a-z0-9]+/, '');

  // Approval, restore and permanent purge belong to the owner in the app.
  if (OWNER_ONLY_CUE.test(text) || (QUARANTINE_CUE.test(text) && (PERMANENT_CUE.test(text) || DELETE_CUE.test(text)))) {
    return intent('owner_only');
  }
  // A plan, or what became of an approved download, is a status read.
  if (PLAN_ID_CUE.test(text) || (PLAN_CUE.test(text) && PLAN_STATE_CUE.test(text)) || DOWNLOAD_OUTCOME_CUE.test(text)) {
    return intent('status');
  }
  if (QUEUE_SUBJECT_CUE.test(text) && QUEUE_QUESTION_CUE.test(text) && !DOWNLOAD_COMMAND_CUE.test(opening)) {
    return intent('queue');
  }
  if (CONVERT_CUE.test(text)) return intent('convert');
  if (MAINTENANCE_CUE.test(text)) return intent('maintenance');
  if (DELETE_CUE.test(text)) return intent('delete');
  if (INSPECT_CUE.test(text)) return intent('inspect');
  if (DOWNLOAD_CUE.test(text)) return intent('download');
  if (SEARCH_CUE.test(text)) return intent('other');
  if (SERVER_CUE.test(text)) return intent('server');
  // Questions about what is owned, and listings by type or year, are library
  // reads: a year or a type is a filter, never a title to search for.
  if (MEDIA_NOUN_CUE.test(text) &&
      (POSSESSION_CUE.test(text) || LIST_CUE.test(text) || WHICH_MEDIA_CUE.test(text) || NUMBERED_ITEM_CUE.test(text))) {
    return intent('library');
  }
  if (MEDIA_NOUN_CUE.test(text)) return intent('other');
  return undefined;
}

/** Phase a message starts from. The reducer only honours it with the grounding it needs. */
function entryPhase(intent: WorkflowIntent | undefined, message: string, history: ChatMessage[]): Phase {
  const kind = intent?.kind;
  if (kind && READ_INTENTS.has(kind)) return 'orient';
  if (kind === 'maintenance') return 'maintain';
  if (kind === 'delete' || kind === 'convert' || kind === 'inspect') return 'discover';
  return heuristicPhase(message, history);
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

/** Collects up to `limit` values of `key`: every result of a listing, not only the first. */
function collectRefStrings(value: unknown, key: 'mediaRef' | 'releaseRef', out: string[], limit: number, depth = 0): void {
  if (out.length >= limit || depth > 3 || !value) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, limit)) collectRefStrings(item, key, out, limit, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const direct = record[key];
    if (typeof direct === 'string' && out.length < limit) out.push(direct);
    for (const nestedKey of ['data', 'items', 'results']) {
      if (record[nestedKey]) collectRefStrings(record[nestedKey], key, out, limit, depth + 1);
    }
  }
}

function collectPaths(parsed: unknown, out: string[]): void {
  const record = parsed as Record<string, any> | null;
  if (!record) return;
  const data = record.data;
  const candidates = Array.isArray(data) ? data : data ? [data] : [];
  for (const item of candidates.slice(0, REFERENCE_LIMITS.paths)) {
    const p = item?.path ?? item?.relativePath ?? item?.logicalPath;
    if (typeof p === 'string' && p.length > 0 && p.length <= 300) out.push(p);
  }
  // manage_files lists `{ path, items: [{ name, type, path }] }`. Each item carries its
  // exact canonical path; older listings only had names relative to `path`.
  if (Array.isArray(record.items)) {
    const base = typeof record.path === 'string' ? record.path.replace(/[\\/]+$/, '') : '';
    for (const item of record.items.slice(0, REFERENCE_LIMITS.paths)) {
      // Directory entries remain available for browsing, but never ground a
      // deletion proposal over all children of that directory.
      if (item?.type !== 'file') continue;
      const own = item?.path ?? item?.relativePath;
      const name = typeof own === 'string' ? own : typeof item?.name === 'string' ? (base ? `${base}/${item.name}` : item.name) : undefined;
      if (typeof name === 'string' && name.length > 0 && name.length <= 300) out.push(name);
    }
  }
}

/** Extracts only the references this tool is entitled to produce. */
export function extractEntitledReferences(
  toolName: string,
  args: Record<string, unknown>,
  parsed: unknown,
): Partial<WorkflowReferences> | undefined {
  const entitlement = REFERENCE_SOURCES[toolName];
  if (!entitlement) return undefined;
  const action = actionOf(args);
  const refs: Partial<WorkflowReferences> = {};

  if (entitlement.media?.includes(action)) {
    const found: string[] = [];
    collectRefStrings(parsed, 'mediaRef', found, REFERENCE_LIMITS.mediaRefs);
    const valid = [...new Set(found.filter(isValidMediaRef).map(ref => ref.trim()))];
    if (valid.length > 0) {
      refs.mediaRef = valid[0];
      refs.mediaRefs = valid;
    }
  }
  if (entitlement.release?.includes(action)) {
    const found: string[] = [];
    collectRefStrings(parsed, 'releaseRef', found, REFERENCE_LIMITS.releaseRefs);
    const valid = [...new Set(found.filter(isValidReleaseRef).map(ref => ref.trim()))];
    if (valid.length > 0) {
      refs.releaseRef = valid[0];
      refs.releaseRefs = valid;
    }
  }
  if (entitlement.paths?.includes(action)) {
    const paths: string[] = [];
    collectPaths(parsed, paths);
    if (paths.length > 0) {
      refs.paths = paths.slice(0, REFERENCE_LIMITS.paths);
      if (toolName === 'media_format' && action === 'analyze') {
        refs.inspectedPaths = [...refs.paths];
      }
    }
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

/** What a successful proposal targeted, as the keys the reducer compares (§2.8). */
function proposalTargets(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === 'catalog') return typeof args.releaseRef === 'string' ? [args.releaseRef.trim()] : [];
  if (toolName === 'media_format') return typeof args.path === 'string' ? [canonicalPathKey(args.path)] : [];
  const paths = typeof args.paths === 'string' ? [args.paths] : Array.isArray(args.paths) ? args.paths : [];
  return paths.filter((path): path is string => typeof path === 'string').map(canonicalPathKey);
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
      const intent = classifyIntent(message);
      const suggestedPhase = entryPhase(intent, message, history);

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
        const phaseOptions = { intentKind: state.intent?.kind, references: state.references };
        const exposedTools = getPhaseTools(currentPhase, phaseOptions);
        const systemPrompt = buildSystemPromptForPhase(locale, currentPhase, phaseOptions);

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
              references: state.references,
              referenceTime: clock(),
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

            let references: Partial<WorkflowReferences> | undefined;
            try {
              const parsed = JSON.parse(dispatchRes.result);
              // The arguments that were validated and dispatched, after normalization.
              const effectiveArgs = dispatchRes.args ?? tc.args;
              // A failed or partial observation must not unlock a mutation.
              // It can still be reported to the user as a partial read.
              const completeResult = dispatchRes.ok && parsed?.status !== 'partial' &&
                !parsed?.sources?.some((source: any) => source.completeness !== 'complete');
              if (completeResult) references = extractEntitledReferences(tc.name, effectiveArgs, parsed);

              const plan = (parsed?.planId ? parsed : parsed?.data?.planId ? parsed.data : undefined) as
                | Record<string, any>
                | undefined;

              if (plan && dispatchRes.ok) {
                if (isProposalCall(tc.name, effectiveArgs)) {
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
                        targets: proposalTargets(tc.name, effectiveArgs),
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
