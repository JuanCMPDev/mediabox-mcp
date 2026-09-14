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
import type { StreamChatOptions, ChatMessage, ToolCallInfo, ToolResultInfo, VirtualToolDef } from '../types.js';
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
import { dispatchToolCall, listNames, missingDomains, retriedTitle } from './dispatch.js';
import { splitTitleYear } from '../tool-router.js';
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
    // A release the server rejected (seeders, size, a strict language) is not a
    // target. In DOWNLOAD-03 (experiment 6, every release rejected) the rejected refs
    // still moved the phase to propose and exposed propose_download (review R10). The
    // owner can still pick one through a typed selection, which grounds it itself.
    if (key === 'releaseRef' && record.rejected === true) return;
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
    // What this turn's own message asks for, before the reducer merges it into the
    // request it continues. Undefined for a typed selection or an unclassified reply.
    let messageIntentKind: IntentKind | undefined;
    const turnText = selection ? selection.value || message : message;
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
      messageIntentKind = intent?.kind;
      const suggestedPhase = entryPhase(intent, message, history);
      // Checked against what the conversation verified before this message's reduce,
      // which may drop an earlier request's references (ADV-02, experiment 6).
      const unverifiedRefs = unverifiedReferenceTokens(message, state, history);

      const prevPhase = state.phase;
      state = reduce(state, { type: 'user_message', text: message, intent, suggestedPhase }, clock);
      if (state.phase !== prevPhase) {
        yield { type: 'phase', phase: state.phase, reason: 'user_message' };
      }
      // Live status of this conversation's open plans (§2.2), for a question about
      // state. The owner approves, rejects or cancels in the app between turns. A
      // proposal or a selection acts instead, and the server checks duplicates.
      // The change also goes into the message: in experiment 5 the state summary
      // alone did not outweigh the previous answer, which the model repeated.
      let planNote = '';
      if (intent && PLAN_STATUS_INTENTS.has(intent.kind)) {
        const updates = await readOpenPlanStatuses(state.proposals, mcpCall, signal);
        for (const update of updates) {
          state = reduce(state, { type: 'operation_status', planId: update.planId, status: update.status }, clock);
          stateNotes.push(`plan ${update.planId} is ${update.status}`);
        }
        planNote = planStatusNote(updates, state.proposals);
      }
      // A pasted reference no tool returned travels with the message the same way:
      // the rule in the prompt alone did not make qwen3.5 refuse it (ADV-02,
      // experiment 6). The note changes no reference, phase or grounding.
      const refNote = unverifiedReferenceNote(unverifiedRefs);
      if (refNote) stateNotes.push(`message named ${unverifiedRefs.length} reference(s) no tool returned: added an unverified-reference note`);
      const notes = [planNote, refNote].filter(Boolean).join('\n\n');
      history.push({ role: 'user', content: notes ? `${message}\n\n${notes}` : message });
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
    let emptyRetried = false;
    let emptyNudge = false;
    const turnProposals: TurnProposal[] = [];
    // Steps the runtime completes itself because they are not decisions (G10, experiment 6).
    const turnCalls: TurnCall[] = [];
    const sourceFailures = new Map<string, SourceFailure>();
    // Sources that did not answer in this turn: every later inference hears them
    // (READ-10, SEARCH-10, experiment 7).
    const failedSources: string[] = [];
    let proposalAttempted = false;
    let choicesEmitted = false;
    let actionNudged = false;
    let actionNudge: ProposalAction | undefined;
    let discardedReply = '';

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
        // The prompt also hears when the last releases read rejected every release; the
        // tools stay the same (review F1, DOWNLOAD-03).
        const promptOptions = releasesAllRejected(turnCalls) ? { ...phaseOptions, releasesAllRejected: true } : phaseOptions;
        const systemPrompt = buildSystemPromptForPhase(locale, currentPhase, promptOptions);

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

        // Only the retry right after an empty completion carries the nudge.
        const nudge = emptyNudge;
        emptyNudge = false;
        // Likewise, only the inference right after a reply that asked instead of proposing.
        const pendingAction = actionNudge;
        actionNudge = undefined;
        const nudges = [
          nudge ? emptyReplyNudge(exposedTools.map(t => t.name)) : '',
          pendingAction ? pendingActionNudge(pendingAction) : '',
          failedSources.length > 0 ? sourceFailureNote(failedSources) : '',
        ].filter(Boolean).map(note => `\n\n${note}`).join('');
        const combinedSystemPrompt = `${prepared.systemPrompt}\n\n${prepared.stateSummary}${nudges}`;

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
          // After a tool call the reply the nudge discarded is stale (review R5).
          discardedReply = '';
          // Check for present_choices (§2.5)
          const choicesCall = accCalls.find(c => c.name === PRESENT_CHOICES_TOOL);
          if (choicesCall) {
            const filledChoices = fillChoiceMediaRefs(choicesCall.args, turnCalls);
            if (filledChoices.filled > 0) {
              trace.guardDecisions.push(`present_choices had ${filledChoices.filled} item(s) without references: filled their mediaRef from this turn's search`);
            }
            const built = buildChoicesEvent(filledChoices.args);
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

            // Any attempt counts, even one dispatch rejects: the nudge must not push
            // a proposal the model already tried and the checks refused.
            if (isProposalAttempt(tc.name, tc.args)) proposalAttempted = true;

            const argsHash = computeArgsHash(tc.args);
            // The first identical repeat of a call whose source did not answer gets
            // that answer again instead of a dispatch: in SEARCH-10 (experiment 6)
            // qwen3.5 repeated the search until the loop guard ended the turn. Nothing
            // is executed, so no tool event and no guard count; a second repeat is
            // dispatched and the loop guard still stops it.
            const failureKey = `${tc.name}:${argsHash}`;
            const failure = sourceFailures.get(failureKey);
            if (failure && !failure.replayed) {
              failure.replayed = true;
              pendingResults.push({ id: tc.id, name: tc.name, ok: failure.ok, source: failure.source, result: replayedSourceFailure(failure.result) });
              trace.guardDecisions.push(`repeated ${tc.name} call after a source failure: replayed its result without dispatch`);
              continue;
            }
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
            let parsedResult: unknown;
            let completeResult = false;
            try {
              const parsed = JSON.parse(dispatchRes.result);
              parsedResult = parsed;
              // The arguments that were validated and dispatched, after normalization.
              const effectiveArgs = dispatchRes.args ?? tc.args;
              // A failed or partial observation must not unlock a mutation.
              // It can still be reported to the user as a partial read.
              completeResult = dispatchRes.ok && parsed?.status !== 'partial' &&
                !parsed?.sources?.some((source: any) => source.completeness !== 'complete');
              if (completeResult) references = extractEntitledReferences(tc.name, effectiveArgs, parsed);

              // operation_status answers with the plan summary, keyed by `id`.
              const summaryPlan = typeof parsed?.id === 'string' && parsed.id.startsWith('plan_') && typeof parsed?.status === 'string'
                ? { planId: parsed.id, status: parsed.status }
                : undefined;
              const plan = (parsed?.planId ? parsed : parsed?.data?.planId ? parsed.data : summaryPlan) as
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
                    turnProposals.push({
                      planId: plan.planId,
                      operation: plan.operation || 'operation',
                      warnings: Array.isArray(plan.warnings) ? plan.warnings.filter((w: unknown): w is string => typeof w === 'string') : [],
                    });
                  }
                } else if (typeof plan.status === 'string') {
                  state = reduce(state, { type: 'operation_status', planId: plan.planId, status: plan.status }, clock);
                }
              }
            } catch {
              // Non-JSON results are ignored for proposal and reference tracking
            }

            turnCalls.push({ tool: tc.name, args: dispatchRes.args ?? tc.args, ok: dispatchRes.ok, complete: completeResult, parsed: parsedResult });
            const sourceFailed = isSourceFailure(parsedResult, dispatchRes.ok);
            if (!sourceFailures.has(failureKey) && sourceFailed) {
              sourceFailures.set(failureKey, { result: dispatchRes.result, ok: dispatchRes.ok, source: dispatchRes.mcpTool, replayed: false });
            }
            // Every later inference of the turn names what is missing (READ-10, SEARCH-10,
            // experiment 7). Only names: the result itself is not repeated (ADV-10).
            if (sourceFailed) {
              if (failedSources.length === 0) trace.guardDecisions.push('a source did not answer: later inferences of the turn carry a source-failure note');
              recordFailedSources(failedSources, failedSourceNames(parsedResult));
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

          // A proposal made on the last inference the turn allows leaves no room for
          // the answer (STORAGE-01 in experiment 5): report it from the proposal
          // result instead of ending the turn on the budget guard.
          if (turnProposals.length > 0 && !guards.hasInferenceBudget()) {
            const finalText = proposalAnswer(turnProposals, locale);
            history.push({ role: 'assistant', content: finalText });
            persistHistory();
            await persistState();
            trace.guardDecisions.push('inference budget spent after a proposal: answered from the proposal result');
            turnCompleted = true;
            yield { type: 'done', fullText: finalText };
            return;
          }
          continue; // Next inference iteration with tool results fed back
        }

        // ── Final Natural Language Response ──────────────────────────────────
        // An empty completion (no text, no tool call) gets one retry. With fixed
        // sampling the identical request returns the same empty reply, so the retry
        // carries a nudge in the system prompt.
        if (!accText.trim() && !emptyRetried && guards.hasInferenceBudget()) {
          emptyRetried = true;
          emptyNudge = true;
          guards.forgiveEmptyInference();
          trace.guardDecisions.push('empty completion: retried once with a nudge');
          continue;
        }

        // The request as the owner stated it: the stored intent summary plus this
        // turn's text, so a year, type, language or resolution of the first message
        // still counts after a card selection or a follow-up like "la de 2017"
        // (review R1-R3).
        const requestText = `${state.intent?.summary ?? ''}\n${turnText}`;

        // Homonyms a download search returned are presented as cards when the reply
        // only listed them in text: in SEARCH-06/07 (experiment 6) both models asked
        // "¿cuál?" without present_choices, so the owner had nothing to select. The
        // cards carry the returned mediaRefs only; the owner still chooses. Only the
        // owner tells them apart, with a typed selection or a request that fits one of
        // them: a homonym the model read on its own still gets the cards (review R3).
        const homonyms = homonymGroup(turnCalls);
        const undecided = homonyms && !selection && !requestPicksHomonym(homonyms, requestText) ? homonyms : undefined;
        let cardsPrompt = '';
        if (undecided && !choicesEmitted && !proposalAttempted && state.intent?.kind === 'download') {
          const built = buildChoicesEvent(homonymChoices(undecided, locale));
          if (built) {
            yield built.event;
            state = reduce(state, { type: 'candidates_presented', candidates: built.candidates }, clock);
            choicesEmitted = true;
            cardsPrompt = built.event.prompt ?? '';
            trace.guardDecisions.push(`download search returned ${built.candidates.length} homonyms and the reply presented no choices: the runtime presented them`);
          }
        }

        // A reply that ends asking to confirm a resolved target gets one more
        // inference that names the proposal action: in nine scenarios of experiment 6
        // (DOWNLOAD-01/02/05/06/07/09/10, STORAGE-01/05) qwen3.5 asked "¿Deseas
        // descargar esta versión?" instead of proposing, and the owner approves in
        // the app anyway. The question is not kept; the model still chooses the
        // target and the proposal still passes grounding.
        const pending = accText.trim() && !actionNudged && !choicesEmitted && !proposalAttempted && guards.hasInferenceBudget()
          ? pendingProposalAction({
            kind: state.intent?.kind,
            requestKind: selection ? state.intent?.kind : messageIntentKind,
            phase: state.phase,
            exposedTools,
            references: state.references,
            calls: turnCalls,
            requestText,
            // This turn's homonyms, and the media cards of an earlier turn the owner has
            // not chosen (review F4).
            undecidedMediaRefs: new Set([
              ...(undecided?.map(entry => entry.mediaRef) ?? []),
              ...unchosenPresentedMedia(state.candidates, state.selections, requestText),
            ]),
          })
          : undefined;
        if (pending) {
          actionNudged = true;
          actionNudge = pending;
          // Kept as the answer if the nudged inference, and its possible empty retry,
          // end with no text and no tool call: better than "(sin respuesta)" (review R5).
          discardedReply = accText;
          guards.forgiveEmptyInference();
          trace.guardDecisions.push(`reply ended without proposing a resolved target: retried once with a nudge to call ${pending.tool}.${pending.action}`);
          continue;
        }

        const finalText = accText || cardsPrompt || discardedReply || fallbacks.empty;
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

/**
 * Nudge for the retry of an empty completion. It names the tools, because a call
 * to a tool that is not offered is dropped by the runtime and looks empty: that
 * is the likely cause of READ-14's 30 invisible tokens in experiment 5.
 */
function emptyReplyNudge(toolNames: string[]): string {
  return `Your previous reply was empty; a call to a tool that is not available is discarded. Available now: ${toolNames.join(', ')}. Reply to the last user message: answer with the data you have, or call one of those tools.`;
}

/* ── Unverified references in a message (ADV-02, experiment 6) ──────────── */

/** The reference shapes workflow.ts accepts, unanchored, to find them in text. */
const REFERENCE_TOKEN = /\b(?:mref|rref)_[A-Za-z0-9_.:=-]{1,220}/g;
const MAX_NOTED_REFERENCES = 3;

/** Reference tokens in `text`, without the sentence punctuation that may follow one. */
function referenceTokens(text: string): string[] {
  return (text.match(REFERENCE_TOKEN) ?? []).map(token => token.replace(/[.:]+$/, '')).filter(token => token.length > 5);
}

/**
 * Tokens of the message that nothing in the conversation verified: not in the
 * references, candidates or selections of `state`, and not in a successful result of
 * `history` from a tool entitled to mint that kind of reference. Call it with the
 * state before the message is reduced.
 */
export function unverifiedReferenceTokens(message: string, state: WorkflowState, history: ChatMessage[]): string[] {
  const found = [...new Set(referenceTokens(message))];
  if (found.length === 0) return [];
  const known = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string') known.add(value.trim()); };
  const refs = state.references;
  add(refs.mediaRef);
  add(refs.releaseRef);
  refs.mediaRefs?.forEach(add);
  refs.releaseRefs?.forEach(add);
  for (const candidate of state.candidates) { add(candidate.mediaRef); add(candidate.releaseRef); }
  for (const chosen of state.selections) { add(chosen.mediaRef); add(chosen.releaseRef); }
  for (const msg of history) {
    // A failed result can echo the token it refused (ERR_REF_INVALID names the value
    // it was given): that is not a tool returning it.
    for (const result of msg.toolResults ?? []) {
      if (result.ok === false) continue;
      for (const token of referenceTokens(result.result)) if (mintsReferenceToken(result.name, token)) add(token);
    }
  }
  return found.filter(token => !known.has(token)).slice(0, MAX_NOTED_REFERENCES);
}

/** The tools of REFERENCE_SOURCES whose results carry catalog references. */
const CATALOG_REFERENCE_TOOLS: ReadonlySet<string> = new Set(['catalog', 'series', 'movies']);

/**
 * True when `toolName` is entitled to mint the kind of `token`: catalog mints media and
 * release references, series and movies release references. The same token in any
 * other result is free text, such as a Jellyfin item named "rref_..." in a media_query
 * result, and verifies nothing (review R7, L2).
 */
function mintsReferenceToken(toolName: string, token: string): boolean {
  if (!CATALOG_REFERENCE_TOOLS.has(toolName)) return false;
  const entitlement = REFERENCE_SOURCES[toolName];
  return token.startsWith('mref_') ? Boolean(entitlement?.media?.length) : Boolean(entitlement?.release?.length);
}

/**
 * The note steers to the refusal the ADV-02 and ADV-07 oracles accept ("no puedo*",
 * and "no es válid*" for ADV-02) and claims nothing about what tools returned, which
 * the runtime cannot know for text outside the history (review R6, L16/L17).
 */
function unverifiedReferenceNote(tokens: string[]): string {
  if (tokens.length === 0) return '';
  const names = tokens.join(', ');
  return tokens.length === 1
    ? `[Mediabox note] ${names} is not a reference verified in this conversation, so you cannot use it: say you cannot use it because it is not valid here; do not look it up.`
    : `[Mediabox note] ${names} are not references verified in this conversation, so you cannot use them: say you cannot use them because they are not valid here; do not look them up.`;
}

/* ── What the tool loop of a turn observed ───────────────────────────────── */

/** A dispatched call of this turn, with the arguments after normalization. */
export interface TurnCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Successful and complete, the test that lets a result mint references. */
  complete: boolean;
  parsed: unknown;
}

interface SourceFailure {
  result: string;
  ok: boolean;
  source?: string;
  replayed: boolean;
}

export interface ProposalAction {
  tool: string;
  action: string;
}

/** A proposal call as the model wrote it, before dispatch normalizes the action. */
function isProposalAttempt(toolName: string, args: Record<string, unknown>): boolean {
  const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : '';
  return isProposalCall(toolName, { action });
}

/** A result in which a source did not answer: partial, incomplete or unreachable. */
function isSourceFailure(parsed: unknown, ok: boolean): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, any>;
  if (record.status === 'partial') return true;
  if (Array.isArray(record.sources) && record.sources.some((source: any) => source?.completeness !== 'complete')) return true;
  return !ok && record.error?.code === 'ERR_UPSTREAM_UNAVAILABLE';
}

/** Replaces the top-level message of a replayed result; compaction keeps 120 characters. */
export const REPEATED_SOURCE_FAILURE_NOTE = 'Already answered in this turn: the source did not answer. Do not call it again; tell the user.';

function replayedSourceFailure(result: string): string {
  try {
    return JSON.stringify({ ...JSON.parse(result), message: REPEATED_SOURCE_FAILURE_NOTE });
  } catch {
    return result;
  }
}

/**
 * The services the MCP server names in an unavailability error: "<service> answered
 * HTTP <status> and is unavailable" (mcp-server security/tool-errors.ts). Only a name
 * of this list is taken from the message; the rest of an error is upstream text, and
 * ADV-10 puts an injection canary and an exfiltration URL in an upstream body.
 */
const UNAVAILABLE_SERVICE = /\b(Jellyfin|Sonarr|Radarr|Prowlarr|qBittorrent|PyLoad|Bazarr) answered HTTP \d{3} and is unavailable\b/i;
/** A source name as envelopes give it ("sonarr"); any other text is not repeated to the model. */
const SOURCE_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,23}$/;
const UNNAMED_SOURCE = 'a service';
const MAX_NOTED_SOURCES = 3;

/**
 * The sources a failed result names, with the detection of isSourceFailure: the
 * incomplete sources of an envelope and the service of an ERR_UPSTREAM_UNAVAILABLE.
 * A source without a usable name is "a service".
 */
function failedSourceNames(parsed: unknown): string[] {
  const record = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, any>;
  const names: string[] = [];
  if (Array.isArray(record.sources)) {
    for (const source of record.sources) {
      if (source?.completeness === 'complete') continue;
      const name = typeof source?.source === 'string' ? source.source.trim() : '';
      names.push(SOURCE_NAME.test(name) ? name : UNNAMED_SOURCE);
    }
  }
  if (record.error?.code === 'ERR_UPSTREAM_UNAVAILABLE') {
    const message = typeof record.error.message === 'string' ? record.error.message : '';
    const service = UNAVAILABLE_SERVICE.exec(message)?.[1];
    // An error envelope that already names its source (catalog.ts propose_download
    // with the queue down) must not add a second, unnamed service (review, exp 8).
    if (service) names.push(service);
    else if (names.length === 0) names.push(UNNAMED_SOURCE);
  }
  return names.length > 0 ? names : [UNNAMED_SOURCE];
}

/** Adds each of `names` once, case-insensitively, up to MAX_NOTED_SOURCES. */
function recordFailedSources(noted: string[], names: string[]): void {
  for (const name of names) {
    if (noted.length >= MAX_NOTED_SOURCES) return;
    if (!noted.some(known => known.toLowerCase() === name.toLowerCase())) noted.push(name);
  }
}

/**
 * The system prompt note of every inference after a source failure in the turn.
 * READ-10 (0/3) and SEARCH-10 (2 of 3 passes), experiment 7: with Sonarr down, qwen3.5
 * answered that the series had no results although the result's note named sonarr.
 * That note is in one tool result; this one is on every later inference of the turn.
 * It adds no inference and changes no tool, phase or reference.
 */
function sourceFailureNote(names: string[]): string {
  const who = listNames(names);
  return `In this turn ${who} did not respond, so ${missingDomains(names)} results are missing. Your answer must say that ${who} did not respond; never say that nothing was found or that it does not exist.`;
}

/* ── Homonym cards (SEARCH-06/07, experiment 6) ──────────────────────────── */

function foldTitle(value: string): string {
  // \p{M}: the combining accents NFD splits off, so "Éclipse" folds to "eclipse".
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const MEDIA_TYPE_LABELS: Record<'es' | 'en', Record<string, string>> = {
  es: { movie: 'película', series: 'serie' },
  en: { movie: 'movie', series: 'series' },
};

const HOMONYM_PROMPT: Record<'es' | 'en', string> = {
  es: '¿Cuál de estos títulos quieres?',
  en: 'Which of these titles do you mean?',
};

interface Homonym {
  title: string;
  year?: number;
  type?: string;
  mediaRef: string;
}

/** The object items of the last complete catalog search of the turn, with its call. */
function lastCompleteSearch(calls: TurnCall[]): { call: TurnCall; items: Record<string, unknown>[] } | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c.tool !== 'catalog' || actionOf(c.args) !== 'search' || !c.ok || !c.complete) continue;
    const data = (c.parsed as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) return undefined;
    return { call: c, items: data.filter((raw): raw is Record<string, unknown> => Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)) };
  }
  return undefined;
}

/**
 * The homonyms of the last complete catalog search of the turn: at least two returned
 * items with a different (year, type) whose folded title equals the folded query or,
 * when the result is dispatch's retry of an empty search (READ-13), the title it
 * searched instead; each also without a trailing "(2017)": the router searches that as
 * title and year (splitTitleYear), and dispatch turns '"Eclipse" (2017)' into "Eclipse (2017)".
 * No other group: falling back to the first ambiguous group of the result offered
 * titles the owner never asked for (review R3).
 */
function homonymGroup(calls: TurnCall[]): Homonym[] | undefined {
  const search = lastCompleteSearch(calls);
  if (!search) return undefined;
  const rawQuery = search.call.args.query;
  const query = typeof rawQuery === 'string' ? rawQuery : '';
  // The normalized title only when dispatch searched it, which its retry note says. A
  // search for "El Show de Truman" that found the 1998 film offered "Truman (1995)" and
  // "Truman (2015)" as cards, which also kept the nudge off (review F3).
  const retried = retriedTitle(query, (search.call.parsed as { message?: unknown } | undefined)?.message);
  const titles = [query, retried ?? ''].flatMap(title => [title, String(splitTitleYear(title, undefined).query)]);
  const keys = [...new Set(titles.map(foldTitle).filter(Boolean))];
  for (const key of keys) {
    const group: Homonym[] = [];
    for (const item of search.items) {
      if (typeof item.title !== 'string' || foldTitle(item.title) !== key || !isValidMediaRef(item.mediaRef)) continue;
      const entry: Homonym = {
        title: item.title.trim(),
        year: typeof item.year === 'number' ? item.year : undefined,
        type: typeof item.type === 'string' ? item.type : undefined,
        mediaRef: (item.mediaRef as string).trim(),
      };
      // The same (year, type) twice would give two identical cards.
      if (!group.some(other => other.year === entry.year && other.type === entry.type)) group.push(entry);
    }
    if (group.length >= 2) return group.slice(0, MAX_CHOICE_ITEMS);
  }
  return undefined;
}

/** Years and type words of a request, over lower-case text without accents. */
const YEAR_IN_TEXT = /\b(?:19|20)\d{2}\b/g;
const MOVIE_WORD = /\b(?:pelicula|movie|film)\b/;
const SERIES_WORD = /\b(?:serie|series|show)\b/;

/**
 * The homonym the request text itself picks: filtering the group by the years and by
 * the type word (película, movie, film; serie, series, show) the text names leaves
 * exactly one member, with at least one filter applied. A typed selection is the
 * caller's check. This replaces "a later call of the turn used one of them", which let
 * a model pick a homonym on its own, read its releases and skip the cards (review R3).
 * `untypedFits` lets a member of unknown type through the type filter: a card label
 * names the type only where two cards share a year (review F4).
 */
function pickHomonym(group: Homonym[], requestText: string, untypedFits = false): Homonym | undefined {
  const text = foldTitle(requestText);
  const years = new Set((text.match(YEAR_IN_TEXT) ?? []).map(Number));
  const types = new Set<string>();
  if (MOVIE_WORD.test(text)) types.add('movie');
  if (SERIES_WORD.test(text)) types.add('series');
  let members = group;
  let filtered = false;
  if (years.size > 0) {
    members = members.filter(entry => entry.year !== undefined && years.has(entry.year));
    filtered = true;
  }
  // A text with both type words names no type.
  if (types.size === 1) {
    members = members.filter(entry => (entry.type === undefined ? untypedFits : types.has(entry.type)));
    filtered = true;
  }
  return filtered && members.length === 1 ? members[0] : undefined;
}

function requestPicksHomonym(group: Homonym[], requestText: string): boolean {
  return pickHomonym(group, requestText) !== undefined;
}

/** present_choices arguments for a homonym group, with the returned mediaRefs only. */
function homonymChoices(group: Homonym[], locale: string): Record<string, unknown> {
  const tag = locale === 'es' ? 'es' : 'en';
  const items = group.map(entry => {
    const sharesYear = group.filter(other => other.year === entry.year).length > 1;
    const typeLabel = sharesYear && entry.type ? MEDIA_TYPE_LABELS[tag][entry.type] ?? entry.type : '';
    const detail = [entry.year !== undefined ? String(entry.year) : '', typeLabel].filter(Boolean).join(', ');
    const label = detail ? `${entry.title} (${detail})` : entry.title;
    return { label, value: label, mediaRef: entry.mediaRef, selectionType: 'select_candidate' };
  });
  return { prompt: HOMONYM_PROMPT[tag], items };
}

/**
 * Fills the mediaRef of model-written present_choices items that carry no valid
 * reference, so the owner gets cards that select something (review R8, L14). An item
 * gets the mediaRef of the single returned item of the turn's last complete catalog
 * search whose folded title is in the item's label or value and whose year, when it
 * has one, appears there too. Only server-returned mediaRefs, never releaseRefs.
 */
function fillChoiceMediaRefs(args: Record<string, unknown>, calls: TurnCall[]): { args: Record<string, unknown>; filled: number } {
  const search = Array.isArray(args.items) ? lastCompleteSearch(calls) : undefined;
  if (!search) return { args, filled: 0 };
  const returned = search.items
    .filter(item => typeof item.title === 'string' && foldTitle(item.title) && isValidMediaRef(item.mediaRef))
    .map(item => ({
      title: foldTitle(item.title as string),
      year: typeof item.year === 'number' ? new RegExp(`\\b${Math.trunc(item.year)}\\b`) : undefined,
      mediaRef: (item.mediaRef as string).trim(),
    }));
  let filled = 0;
  const items = (args.items as unknown[]).map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const item = raw as Record<string, unknown>;
    if (isValidMediaRef(item.mediaRef) || isValidReleaseRef(item.releaseRef)) return raw;
    const text = foldTitle([item.label, item.value].filter((part): part is string => typeof part === 'string').join(' '));
    if (!text) return raw;
    const matches = new Set(returned
      .filter(entry => text.includes(entry.title) && (!entry.year || entry.year.test(text)))
      .map(entry => entry.mediaRef));
    if (matches.size !== 1) return raw;
    filled++;
    return { ...item, mediaRef: [...matches][0], selectionType: 'select_candidate' };
  });
  return filled > 0 ? { args: { ...args, items }, filled } : { args, filled: 0 };
}

/* ── Media cards of an earlier turn (review F4) ──────────────────────────── */

/** The detail in the trailing parentheses of a card label: "Eclipse (2017, película)". */
const LABEL_DETAIL = /\(([^()]*)\)\s*$/;

/** A presented media card as a homonym: the year and the type its label names, if any. */
function labelHomonym(label: string, mediaRef: string): Homonym {
  const detail = foldTitle(LABEL_DETAIL.exec(label)?.[1] ?? '');
  const years = detail.match(YEAR_IN_TEXT) ?? [];
  const movie = MOVIE_WORD.test(detail);
  const series = SERIES_WORD.test(detail);
  return {
    title: label,
    year: years.length > 0 ? Number(years[years.length - 1]) : undefined,
    type: movie === series ? undefined : movie ? 'movie' : 'series',
    mediaRef,
  };
}

/**
 * mediaRefs of the media cards the conversation presented (two or more media, no
 * release on the card) that the owner has not chosen. Chosen is the card of the last
 * typed selection among them, or the one the request text picks among their labels
 * with the test of the cards. Reproduced in review F4: after cards for Eclipse 2004 and
 * 2017, "Descárgala en 1080p." came as free text, the model read the 2017 releases on
 * its own and the nudge created plan_e2017, although the owner never picked 2017.
 */
function unchosenPresentedMedia(candidates: CandidateRecord[], selections: TypedSelection[], requestText: string): string[] {
  const media = new Map<string, Homonym>();
  for (const candidate of candidates) {
    if (candidate.releaseRef || !isValidMediaRef(candidate.mediaRef)) continue;
    const mediaRef = candidate.mediaRef.trim();
    if (!media.has(mediaRef)) media.set(mediaRef, labelHomonym(candidate.label, mediaRef));
  }
  if (media.size < 2) return [];
  const chosen = new Set<string>();
  const selected = [...selections].reverse().find(s => isValidMediaRef(s.mediaRef) && media.has(s.mediaRef.trim()));
  if (selected?.mediaRef) chosen.add(selected.mediaRef.trim());
  const picked = pickHomonym([...media.values()], requestText, true);
  if (picked) chosen.add(picked.mediaRef);
  return [...media.keys()].filter(mediaRef => !chosen.has(mediaRef));
}

/* ── Releases that were all rejected (review F1) ─────────────────────────── */

/**
 * True when the last complete catalog releases read of the turn returned releases and
 * the server rejected every one. DOWNLOAD-03 asks for Japanese audio that no release
 * has: with R10 that read leaves the phase at select, where the prompt said to
 * "retrieve releases" again. Exported for its tests.
 */
export function releasesAllRejected(calls: TurnCall[]): boolean {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c.tool !== 'catalog' || actionOf(c.args) !== 'releases' || !c.ok || !c.complete) continue;
    const data = (c.parsed as { data?: unknown } | undefined)?.data;
    return Array.isArray(data) && data.length > 0 &&
      data.every(item => Boolean(item) && typeof item === 'object' && (item as Record<string, unknown>).rejected === true);
  }
  return false;
}

/* ── Nudge of a pending proposal (experiment 6) ──────────────────────────── */

const PROPOSAL_ACTION_OF: Partial<Record<IntentKind, ProposalAction>> = {
  download: { tool: 'catalog', action: 'propose_download' },
  delete: { tool: 'library_ops', action: 'propose_delete' },
  convert: { tool: 'media_format', action: 'propose' },
};

/**
 * An audio language named in the request, over lower-case text without accents.
 * DOWNLOAD-03 asks for Japanese audio that no release has: without the language in
 * the releases call, a release that was not rejected is not a resolved target.
 */
const AUDIO_LANGUAGE_CUE = /\b(latino|latina|latinoamericano|espanol|espanola|castellano|spanish|ingles|inglesa|english|japones|japonesa|japanese|frances|francesa|french|aleman|alemana|german|italiano|italiana|italian|portugues|portuguesa|portuguese|brasileno|coreano|coreana|korean|chino|chinese|mandarin|cantones|ruso|rusa|russian|hindi|arabe|arabic|catalan|euskera|polaco|polish|turco|turkish|neerlandes|dutch|sueco|swedish)\b/;

/**
 * A resolution named in the request, over lower-case text without accents. 4k and uhd
 * mean 2160p, the value find_releases reports (mcp-server queries/releases.ts).
 */
const RESOLUTION_CUE = /\b(?:480p|576p|720p|1080p|2160p|4k|uhd)\b/g;

function canonicalResolution(value: string): string {
  const folded = value.trim().toLowerCase();
  return folded === '4k' || folded === 'uhd' ? '2160p' : folded;
}

/**
 * The proposal action a text reply should have called: a proposal request in
 * `propose` with that action offered, and a target this turn's own reads resolved.
 * `requestText` is the stored intent summary plus this turn's text, so a language or
 * resolution named in the first message still counts after a card selection or a
 * follow-up such as "la de 2017" (review R1, R2). A message that asks for something
 * else ("show me the versions") is not nudged. Exported for its tests.
 */
export function pendingProposalAction(opts: {
  kind: IntentKind | undefined;
  requestKind: IntentKind | undefined;
  phase: Phase;
  exposedTools: VirtualToolDef[];
  references: WorkflowReferences;
  calls: TurnCall[];
  requestText: string;
  /** mediaRefs of homonyms or media cards the owner has not told apart (review R3, F4). */
  undecidedMediaRefs: ReadonlySet<string>;
}): ProposalAction | undefined {
  const target = opts.kind ? PROPOSAL_ACTION_OF[opts.kind] : undefined;
  if (!target || opts.phase !== 'propose') return undefined;
  if (opts.requestKind !== undefined && opts.requestKind !== opts.kind) return undefined;
  const offered = (opts.exposedTools.find(t => t.name === target.tool)?.parameters as any)?.properties?.action?.enum;
  if (!Array.isArray(offered) || !offered.includes(target.action)) return undefined;

  // Paths or an analysis kept from an earlier turn are not this turn's resolution:
  // the nudge needs the listing or the analysis read now (review R4).
  const readThisTurn = (tool: string, action: string) =>
    opts.calls.some(c => c.tool === tool && actionOf(c.args) === action && c.ok && c.complete);
  if (opts.kind === 'delete') return opts.references.paths?.length && readThisTurn('library_ops', 'list') ? target : undefined;
  if (opts.kind === 'convert') return opts.references.inspectedPaths?.length && readThisTurn('media_format', 'analyze') ? target : undefined;

  const text = foldTitle(opts.requestText);
  const namesLanguage = AUDIO_LANGUAGE_CUE.test(text);
  // The last resolution the request names. The summary keeps the earlier messages of
  // the request (review F2), and "en 720p" then "descárgala en 1080p" asks for 1080p:
  // one resolution is never looser than the set of one message it replaces.
  const named = text.match(RESOLUTION_CUE) ?? [];
  const resolution = named.length > 0 ? canonicalResolution(named[named.length - 1]) : undefined;
  const resolved = opts.calls.some(c => {
    if (c.tool !== 'catalog' || actionOf(c.args) !== 'releases' || !c.ok || !c.complete) return false;
    // Defense in depth for the homonym cards: the releases of a homonym the owner did
    // not pick are not the requested target (review R3).
    if (typeof c.args.mediaRef === 'string' && opts.undecidedMediaRefs.has(c.args.mediaRef.trim())) return false;
    // A named language counts only in a call that requires it: strictLanguage false
    // also returns releases without that language (review R1).
    if (namesLanguage && (!(typeof c.args.audioLanguage === 'string' && c.args.audioLanguage.trim()) || c.args.strictLanguage === false)) return false;
    const data = (c.parsed as { data?: unknown } | undefined)?.data;
    return Array.isArray(data) && data.some(raw => {
      if (!raw || typeof raw !== 'object') return false;
      const item = raw as Record<string, unknown>;
      if (item.rejected === true || !isValidReleaseRef(item.releaseRef)) return false;
      // A named resolution counts only with a release of that resolution (review R2).
      return resolution === undefined || (typeof item.resolution === 'string' && canonicalResolution(item.resolution) === resolution);
    });
  });
  return resolved ? target : undefined;
}

/**
 * Conditional per kind: the reads of the turn returned candidates, and whether one of
 * them is what the user asked for is still the model's call. The previous wording
 * claimed "the exact target is resolved" (review R4).
 */
function pendingActionNudge(action: ProposalAction): string {
  const call = `${action.tool}(action:"${action.action}")`;
  const lead = `Your reply ended without proposing, and ${call} is available. The owner approves in the Mediabox app, never in this chat, so do not ask for confirmation.`;
  switch (action.action) {
    case 'propose_download':
      return `${lead} The releases read returned releases that were not rejected: if one of them meets every constraint the user stated, call ${call} now with it and report the returned approval state; if none does, say so in one sentence and propose nothing.`;
    case 'propose_delete':
      return `${lead} The listing returned exact file paths: if one of them is exactly the file the user asked for, call ${call} now with only that path and report the returned approval state; if none is, say so in one sentence and propose nothing.`;
    default:
      return `${lead} If the analyzed file is exactly the file the user asked for and the requested job applies, call ${call} now and report the returned approval state; otherwise say so in one sentence and propose nothing.`;
  }
}

interface TurnProposal {
  planId: string;
  operation: string;
  warnings: string[];
}

const OPERATION_LABELS: Record<'es' | 'en', Record<string, string>> = {
  es: {
    quarantine_files: 'mover a cuarentena los archivos elegidos',
    media_download: 'descargar el release elegido',
    media_format_conversion: 'convertir el archivo elegido',
  },
  en: {
    quarantine_files: 'move the selected files to quarantine',
    media_download: 'download the selected release',
    media_format_conversion: 'convert the selected file',
  },
};

/** Answer built from the proposal results when no inference is left to write one. */
function proposalAnswer(proposals: TurnProposal[], locale: string): string {
  const es = locale === 'es';
  const labels = OPERATION_LABELS[es ? 'es' : 'en'];
  const lines = proposals.map(p => (es
    ? `Propuse el plan ${p.planId} para ${labels[p.operation] ?? p.operation}. Está pendiente de tu aprobación en la aplicación Mediabox; hasta entonces no se cambia nada.`
    : `I proposed plan ${p.planId} to ${labels[p.operation] ?? p.operation}. It awaits your approval in the Mediabox app; nothing changes until then.`));
  const warnings = proposals.flatMap(p => p.warnings);
  if (warnings.length > 0) lines.push(`${es ? 'Avisos' : 'Warnings'}: ${warnings.join(' ')}`);
  return lines.join('\n\n');
}

const PLAN_STATUS_MEANING: Record<string, string> = {
  rejected: 'the owner declined it in the app, so nothing was changed or downloaded',
  cancelled: 'it was cancelled and did not complete',
  expired: 'it expired without approval, so nothing was changed',
  failed: 'it failed and did not complete',
  unknown_outcome: 'its outcome is unknown',
  interrupted: 'it was interrupted and did not complete',
  partial: 'it completed only in part',
  queued: 'the owner approved it and it is in progress',
  running: 'the owner approved it and it is in progress',
  verifying: 'the owner approved it and it is being verified',
};

/** The status changes read at the start of the turn, as a note the model reads with the message. */
function planStatusNote(updates: Array<{ planId: string; status: string }>, proposals: WorkflowState['proposals']): string {
  if (updates.length === 0) return '';
  const lines = updates.map(u => {
    const operation = proposals.find(p => p.planId === u.planId)?.operation ?? 'operation';
    // A succeeded download only sent the release: in experiment 6 DOWNLOAD-08 turn 2
    // answered "ya está disponible en su biblioteca" after this note, and DOWNLOAD-09
    // forbids "ya está disponible". The word "sent" is what DOWNLOAD-08 accepts (review R9).
    const meaning = u.status === 'succeeded'
      ? (operation === 'media_download'
        ? 'the plan only sent the release to the downloader, which does not mean it is in the library; unless downloads or the library show it, say it is not available yet and may still be downloading'
        : 'it completed')
      : PLAN_STATUS_MEANING[u.status] ?? `its status is ${u.status}`;
    return `Plan ${u.planId} (${operation}) is ${u.status}: ${meaning}.`;
  });
  return `[Mediabox plan update, read from the server at the start of this turn] ${lines.join(' ')}`;
}

const OPEN_PLAN_STATUSES = new Set(['planned', 'awaiting_approval', 'queued', 'running', 'verifying', 'cancel_requested']);
/** Questions about state, where a stale plan status would reach the answer. */
const PLAN_STATUS_INTENTS: ReadonlySet<IntentKind> = new Set<IntentKind>(['status', 'queue', 'library', 'server']);
const MAX_PLAN_STATUS_READS = 3;

/** Status of `planId` in an operation_status result: the plan summary ({id, status}) or an envelope. */
function planStatusOf(parsed: unknown, planId: string): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, any>;
  for (const candidate of [root, root.data]) {
    if (candidate && typeof candidate === 'object' && (candidate.id === planId || candidate.planId === planId) && typeof candidate.status === 'string') {
      return candidate.status;
    }
  }
  return undefined;
}

/**
 * Reads the live status of the most recent open plans of the conversation. A
 * failed read keeps the recorded status: the model can still read it itself.
 */
export async function readOpenPlanStatuses(
  proposals: WorkflowState['proposals'],
  mcpCall: StreamChatOptions['mcpCall'],
  signal?: AbortSignal,
): Promise<Array<{ planId: string; status: string }>> {
  const open = proposals.filter(p => OPEN_PLAN_STATUSES.has(p.status)).slice(-MAX_PLAN_STATUS_READS);
  const updates: Array<{ planId: string; status: string }> = [];
  for (const proposal of open) {
    if (signal?.aborted) break;
    try {
      const status = planStatusOf(JSON.parse(await mcpCall('operation_status', { planId: proposal.planId }, { signal })), proposal.planId);
      if (status && status !== proposal.status) updates.push({ planId: proposal.planId, status });
    } catch {
      /* keep the recorded status */
    }
  }
  return updates;
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
