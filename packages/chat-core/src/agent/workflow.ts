/* ─── Workflow State, Events and Reducer ────────────────────────────────────
 * Pure state reducer without I/O (§2.2 / AGT-05 / AGT-06).
 *
 * Determinism rules (§6.12): no Date.now(), no Math.random(). Every timestamp
 * comes from the injected ClockFn so a replay produces byte-identical states.
 * ──────────────────────────────────────────────────────────────────────── */
import type { Phase, TypedSelection } from '@mediabox/contracts';
import { AgentError } from './errors.js';

/** Current workflow state schema. v1 states are migrated explicitly (§2.2). */
export const WORKFLOW_SCHEMA_VERSION = 2 as const;

/** How long a reference minted during a turn stays usable (§2.2 `references.expiresAt`). */
export const REFERENCE_TTL_MS = 10 * 60 * 1000;

/** Upper bound for the persisted intent summary so it can never eat the prompt budget (§2.4). */
export const INTENT_SUMMARY_MAX_CHARS = 300;

/**
 * Reference token shapes accepted into the state. The server mints `mref_<12 hex>` /
 * `rref_<12 hex>` today and signed `<base64url>.<hmac>` refs before that, so the
 * check is a bounded opaque-token shape rather than one minting scheme: a prefix
 * for its own kind, a safe charset and a length cap. That is what stops prose or
 * an injected instruction from being stored as a reference; which tool is allowed
 * to mint one at all is decided by the entitlement map in the runtime (§2.7).
 */
export const MEDIA_REF_PATTERN = /^mref_[A-Za-z0-9_.:=-]{1,220}$/;
export const RELEASE_REF_PATTERN = /^rref_[A-Za-z0-9_.:=-]{1,220}$/;

export function isValidMediaRef(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_REF_PATTERN.test(value.trim());
}

export function isValidReleaseRef(value: unknown): value is string {
  return typeof value === 'string' && RELEASE_REF_PATTERN.test(value.trim());
}

/**
 * What the user asks for. It decides which tools a turn offers (§2.3):
 * - `download`, `delete` and `convert` end in a proposal the owner approves;
 * - `queue`, `status`, `library`, `server` and `owner_only` are local reads;
 * - `inspect` reads the streams of one file; `maintenance` is its own flow;
 * - `other` is a catalog search or a question that fits none of the above.
 */
export type IntentKind =
  | 'download' | 'delete' | 'convert' | 'inspect' | 'maintenance'
  | 'status' | 'queue' | 'library' | 'server' | 'owner_only' | 'other';

/** Intents whose request ends in a proposal the owner approves in the app. */
export const PROPOSAL_INTENTS: ReadonlySet<IntentKind> = new Set<IntentKind>(['download', 'delete', 'convert']);

/** Read-only intents. They never consume or clear references and never unlock a proposal. */
export const READ_INTENTS: ReadonlySet<IntentKind> = new Set<IntentKind>(['queue', 'status', 'library', 'server', 'owner_only']);

export interface WorkflowIntent {
  kind: IntentKind;
  summary: string;
  /**
   * Significant subject words of the request (titles, names), with verbs and
   * quality words removed. Used to tell "next step of the same request" from
   * "a different request", which is what decides whether references survive.
   */
  subjects?: string[];
  constraints?: Array<{ key: string; value: unknown; strict?: boolean }>;
}

/**
 * Grounding observed by entitled reads within the TTL (§2.2). Each list is bounded
 * and ordered from oldest to newest. A proposal may only use values found here;
 * the MCP server still verifies every reference and path itself.
 */
export interface WorkflowReferences {
  /** Media in focus: the owner's last selection or the first result of the last read. */
  mediaRef?: string;
  /** Release in focus: the owner's selection or the top-ranked result of the last listing. */
  releaseRef?: string;
  /** Every media reference returned by an entitled read. */
  mediaRefs?: string[];
  /** Every release reference returned by an entitled read or selected by the owner. */
  releaseRefs?: string[];
  /** Exact file paths from a complete library_ops.list or media_format.analyze. */
  paths?: string[];
  /** Files with a successful, complete media_format.analyze. Missing in older v2 states: analyze again. */
  inspectedPaths?: string[];
  expiresAt?: string;
}

/** Bounds of each observed list: enough for a season folder or one release listing. */
export const REFERENCE_LIMITS = { mediaRefs: 16, releaseRefs: 32, paths: 40, inspectedPaths: 16 } as const;

export interface ProposalRecord {
  planId: string;
  operation: string;
  status: string;
  manifestHash: string;
  proposalKey: string;
}

export interface ToolCallDigest {
  tool: string;
  argsHash: string;
  resultDigest: string;
  at: string;
}

export interface BudgetSnapshot {
  contextTokens: number;
  inputUsed: number;
  outputReserve: number;
}

/** Candidate presented through present_choices, remembered so `select` stays legitimate (§2.5). */
export interface CandidateRecord {
  label: string;
  mediaRef?: string;
  releaseRef?: string;
}

/** Persisted counter calibration so deviations accumulate across turns (§2.4 / AGT-12). */
export interface TokenizerCalibration {
  factor: number;
  extraMargin: number;
  consecutiveDeviations: number;
}

export interface WorkflowState {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  conversationId: string;
  principalId: string;
  installationId: string;
  phase: Phase;
  intent?: WorkflowIntent;
  references: WorkflowReferences;
  selections: TypedSelection[];
  candidates: CandidateRecord[];
  proposals: ProposalRecord[];
  /**
   * What each plan of the conversation proposed (release refs or canonical path
   * keys), by planId. A plan missing here predates this field.
   */
  proposalTargets?: Record<string, string[]>;
  lastToolCalls: ToolCallDigest[]; // window of 8
  budgetSnapshot?: BudgetSnapshot;
  calibration?: TokenizerCalibration;
  turn: number;
  updatedAt: string;
}

export type WorkflowEvent =
  | { type: 'user_message'; text: string; intent?: WorkflowIntent; suggestedPhase?: Phase }
  | { type: 'typed_selection'; selection: TypedSelection }
  | { type: 'tool_result'; tool: string; argsHash: string; resultDigest: string; references?: Partial<WorkflowReferences> }
  | { type: 'candidates_presented'; candidates: CandidateRecord[] }
  | { type: 'proposal_created'; planId: string; operation: string; status: string; manifestHash: string; proposalKey: string; targets?: string[] }
  | { type: 'operation_status'; planId: string; status: string }
  | { type: 'phase_transition'; to: Phase; reason: string }
  | { type: 'calibration'; calibration: TokenizerCalibration }
  | { type: 'turn_ended'; budgetSnapshot?: BudgetSnapshot }
  | { type: 'reset' };

export type ClockFn = () => string;
export const defaultClock: ClockFn = () => new Date().toISOString();

export function createInitialWorkflowState(
  conversationId: string,
  principalId: string,
  installationId: string,
  clock: ClockFn = defaultClock,
): WorkflowState {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    conversationId,
    principalId,
    installationId,
    phase: 'orient',
    references: {},
    selections: [],
    candidates: [],
    proposals: [],
    lastToolCalls: [],
    turn: 0,
    updatedAt: clock(),
  };
}

/**
 * Explicit schema migration (§2.2). A v1 state is upgraded in place; an unknown
 * version returns null so the caller discards it and starts fresh instead of
 * interpreting fields it does not understand.
 */
export function migrateWorkflowState(raw: unknown): { state: WorkflowState; migratedFrom?: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<WorkflowState> & { schemaVersion?: number };

  if (candidate.schemaVersion === WORKFLOW_SCHEMA_VERSION) {
    return { state: { ...(candidate as WorkflowState), candidates: candidate.candidates ?? [] } };
  }

  if (candidate.schemaVersion === 1) {
    return {
      migratedFrom: 1,
      state: {
        ...(candidate as unknown as WorkflowState),
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        candidates: [],
        selections: candidate.selections ?? [],
        proposals: candidate.proposals ?? [],
        lastToolCalls: candidate.lastToolCalls ?? [],
        references: candidate.references ?? {},
      },
    };
  }

  return null;
}

function clampSummary(summary: string): string {
  const clean = summary.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
  return clean.length > INTENT_SUMMARY_MAX_CHARS
    ? `${clean.slice(0, INTENT_SUMMARY_MAX_CHARS)}…`
    : clean;
}

/**
 * The summary of a request that a message continues: the earlier summary, then the
 * message, bounded like any summary. A message already in it is not repeated.
 */
function appendSummary(previous: string, next: string): string {
  if (!next || previous.includes(next)) return previous;
  return clampSummary(`${previous} ${next}`);
}

function normalizeIntent(intent: WorkflowIntent): WorkflowIntent {
  return {
    ...intent,
    summary: clampSummary(intent.summary),
    ...(intent.subjects ? { subjects: intent.subjects.slice(0, 8).map(s => s.toLowerCase()) } : {}),
  };
}

/**
 * True when the incoming request is about something the conversation was not
 * already working on. No subject words at all (a refinement like "the 1080p one")
 * is never a new subject.
 */
export function introducesNewSubject(
  previous: WorkflowIntent | undefined,
  incoming: WorkflowIntent,
  candidates: CandidateRecord[] = [],
): boolean {
  const incomingSubjects = (incoming.subjects ?? []).map(s => s.toLowerCase());
  if (incomingSubjects.length === 0) return false;
  // Nothing to compare against: assume the turn continues whatever the earlier turns
  // established, because dropping live references here is the costlier mistake.
  if (!previous) return false;

  const known = new Set<string>((previous.subjects ?? []).map(s => s.toLowerCase()));
  for (const candidate of candidates) {
    for (const word of candidate.label.toLowerCase().split(/[^a-z0-9áéíóúñü]+/i)) {
      if (word.length >= 4) known.add(word);
    }
  }
  if (known.size === 0) return true;

  return !incomingSubjects.some(subject => known.has(subject));
}

function refsExpiry(clock: ClockFn): string {
  return new Date(new Date(clock()).getTime() + REFERENCE_TTL_MS).toISOString();
}

function referencesExpired(refs: WorkflowReferences, now: string): boolean {
  if (!refs.expiresAt) return false;
  return new Date(now).getTime() > new Date(refs.expiresAt).getTime();
}

function hasLiveReference(refs: WorkflowReferences): boolean {
  return Boolean(
    refs.mediaRef || refs.releaseRef || refs.mediaRefs?.length || refs.releaseRefs?.length ||
    refs.paths?.length || refs.inspectedPaths?.length,
  );
}

export function isReferencePath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Default container mounts of the MCP server (storage/namespace-map.ts), longest first. */
const CONTAINER_MOUNTS: ReadonlyArray<readonly [prefix: string, root: string, subdir: string]> = [
  ['/downloads', 'downloads', ''],
  ['/movies', 'media', 'movies'],
  ['/anime', 'media', 'anime'],
  ['/music', 'media', 'music'],
  ['/data', 'media', ''],
  ['/tv', 'media', 'tv'],
];

/**
 * Comparison key of a file path in every form the tools accept or report:
 * "media:tv/x.mkv", "tv/x.mkv", "downloads/x" or a default container path such as
 * "/data/tv/x.mkv". It mirrors the server's default namespace mapping. A form it
 * cannot map (a host path, a custom mount) stays literal and only matches itself.
 */
export function canonicalPathKey(value: string): string {
  let rest = value.normalize('NFC').replace(/\\/g, '/').trim();
  let root = 'media';
  const namespaced = rest.match(/^(media|downloads):(.*)$/);
  if (namespaced) {
    root = namespaced[1];
    rest = namespaced[2];
  } else if (rest.startsWith('/') && !rest.startsWith('//')) {
    const mount = CONTAINER_MOUNTS.find(([prefix]) => rest === prefix || rest.startsWith(`${prefix}/`));
    if (!mount) return `literal:${rest}`;
    root = mount[1];
    rest = `${mount[2]}/${rest.slice(mount[0].length)}`;
  } else if (/^[A-Za-z]:/.test(rest) || rest.startsWith('//')) {
    return `literal:${rest}`;
  } else if (rest === 'downloads' || rest.startsWith('downloads/')) {
    root = 'downloads';
    rest = rest.slice('downloads'.length);
  }
  return `${root}:${rest.split('/').filter(segment => segment.length > 0 && segment !== '.').join('/')}`;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

/** Media references the conversation observed, focus included. */
export function observedMediaRefs(refs: WorkflowReferences): string[] {
  return unique([...(refs.mediaRefs ?? []), refs.mediaRef ?? ''].filter(isValidMediaRef).map(ref => ref.trim()));
}

/** Release references the conversation observed or the owner selected, focus included. */
export function observedReleaseRefs(refs: WorkflowReferences): string[] {
  return unique([...(refs.releaseRefs ?? []), refs.releaseRef ?? ''].filter(isValidReleaseRef).map(ref => ref.trim()));
}

/** Appends values, keeping each one once (by key) and only the newest `limit`. */
function mergeBounded(
  existing: readonly string[] | undefined,
  incoming: readonly string[],
  limit: number,
  keyOf: (value: string) => string = value => value,
): string[] {
  const merged = new Map<string, string>();
  for (const value of [...(existing ?? []), ...incoming]) {
    const key = keyOf(value);
    merged.delete(key);
    merged.set(key, value);
  }
  return [...merged.values()].slice(-limit);
}

/** Drops what was derived for a media entity: its releases, listings and analyses. */
function clearDerived(refs: WorkflowReferences): void {
  delete refs.releaseRef;
  delete refs.releaseRefs;
  delete refs.paths;
  delete refs.inspectedPaths;
}

/** Observed values a proposal of this intent may target, as comparison keys. */
export function groundingKeys(kind: IntentKind | undefined, refs: WorkflowReferences): string[] {
  if (kind === 'download') return observedReleaseRefs(refs);
  if (kind === 'delete') return unique((refs.paths ?? []).filter(isReferencePath).map(canonicalPathKey));
  if (kind === 'convert') return unique((refs.inspectedPaths ?? []).filter(isReferencePath).map(canonicalPathKey));
  return [];
}

/** Read-only intents never unlock a proposal, even when references exist. */
export function hasProposalGrounding(kind: IntentKind | undefined, refs: WorkflowReferences): boolean {
  return groundingKeys(kind, refs).length > 0;
}

function proposedKeys(state: Pick<WorkflowState, 'proposalTargets'>): Set<string> {
  return new Set(Object.values(state.proposalTargets ?? {}).flat());
}

/**
 * True when the grounding holds a target that no plan of the conversation has
 * proposed. A plan recorded before targets were tracked counts as covering all
 * current grounding, so after it only a new observation offers another proposal.
 */
export function hasFreshGrounding(
  kind: IntentKind | undefined,
  state: Pick<WorkflowState, 'references' | 'proposals' | 'proposalTargets'>,
): boolean {
  const keys = groundingKeys(kind, state.references);
  if (keys.length === 0) return false;
  const targets = state.proposalTargets ?? {};
  if (state.proposals.some(proposal => !targets[proposal.planId])) return false;
  const proposed = proposedKeys(state);
  return keys.some(key => !proposed.has(key));
}

/** True when `after` observed a target that `before` lacked and no plan proposed. */
function newUnproposedGrounding(
  kind: IntentKind | undefined,
  before: WorkflowReferences,
  after: WorkflowReferences,
  state: Pick<WorkflowState, 'proposalTargets'>,
): boolean {
  const known = new Set(groundingKeys(kind, before));
  const proposed = proposedKeys(state);
  return groundingKeys(kind, after).some(key => !known.has(key) && !proposed.has(key));
}

/** How far along the flow each phase is. `maintain` is a separate flow, not a step. */
const PHASE_RANK: Record<Phase, number> = {
  orient: 0,
  discover: 1,
  select: 2,
  propose: 3,
  monitor: 3,
  maintain: 0,
};

/**
 * A phase suggestion coming from user text is only honoured when the state has
 * the grounding that phase requires. This is what keeps a pasted or echoed
 * reference from unlocking the propose catalog (§2.3 / AGT-04).
 */
export function groundPhase(target: Phase, state: Pick<WorkflowState, 'references' | 'candidates' | 'proposals' | 'intent'>): Phase {
  switch (target) {
    case 'propose':
      if (hasProposalGrounding(state.intent?.kind, state.references)) return 'propose';
      if (hasLiveReference(state.references) || state.candidates.length > 0) return 'select';
      return 'discover';
    case 'select':
      if (hasLiveReference(state.references) || state.candidates.length > 0) return 'select';
      return 'discover';
    case 'monitor':
      return state.proposals.length > 0 ? 'monitor' : 'orient';
    default:
      return target;
  }
}

/**
 * Pure reducer: reduce(state, event, clock) → state
 * Strictly deterministic when injected with a mock clock.
 */
export function reduce(
  state: WorkflowState,
  event: WorkflowEvent,
  clock: ClockFn = defaultClock,
): WorkflowState {
  if (state.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new AgentError('ERR_WORKFLOW_CORRUPT', `Unsupported workflow schemaVersion: ${state.schemaVersion}`);
  }

  const now = clock();

  switch (event.type) {
    case 'user_message': {
      const received = event.intent ? normalizeIntent(event.intent) : undefined;
      const previous = state.intent;
      // A search without subject words ("look for another version") refines the
      // current request instead of replacing it.
      const incoming = received?.kind === 'other' && !received.subjects?.length && previous ? undefined : received;
      const reads = incoming ? READ_INTENTS.has(incoming.kind) : false;

      // A request supersedes the previous one only when it names a different
      // subject. Escalating within the same subject ("now download the 1080p one")
      // must keep the references the previous turns established.
      const startsNewRequest = Boolean(incoming) && introducesNewSubject(previous, incoming!, state.candidates);

      let references = state.references;
      let candidates = state.candidates;
      if (startsNewRequest || referencesExpired(state.references, now)) {
        references = {};
        candidates = [];
      }

      // A read without subject words ("show the queue") keeps the subjects of the
      // request it interrupts, and with them its references, so that request can
      // resume afterwards ("ok, download it").
      const carried = incoming && reads && !incoming.subjects?.length && previous?.subjects?.length
        ? { ...incoming, subjects: previous.subjects }
        : incoming ?? previous;
      // A message of the same kind that names no new subject continues the request, so
      // its summary keeps the earlier messages (review finding F2). After "Descarga Río
      // Quieto con audio en japonés." and "Sí, descárgala." the summary had lost
      // "japonés", and the runtime, which reads the language and resolution of the
      // request from it, took a releases read without audioLanguage for the target.
      const intent = carried && incoming && previous && !startsNewRequest && incoming.kind === previous.kind
        ? { ...carried, summary: appendSummary(previous.summary, incoming.summary) }
        : carried;
      const grounded = { references, candidates, proposals: state.proposals, intent };
      let nextPhase = state.phase;
      if (reads) {
        // A read leaves an earlier proposal or monitor flow even without subject
        // words ("show the queue"). Its catalog does not depend on the phase.
        nextPhase = 'orient';
      } else if (incoming?.kind === 'maintenance' || (!incoming && event.suggestedPhase === 'maintain')) {
        nextPhase = 'maintain';
      } else if (startsNewRequest) {
        // A different subject starts over from the suggested entry phase.
        nextPhase = groundPhase(event.suggestedPhase ?? 'discover', grounded);
      } else if (incoming && PROPOSAL_INTENTS.has(incoming.kind)) {
        // Asking for a proposal moves as far as the verified grounding allows. From
        // monitor it needs a target no plan proposed yet, so refining an existing
        // plan does not propose the same release or files again.
        const ready = state.phase === 'monitor'
          ? hasFreshGrounding(incoming.kind, { references, proposals: state.proposals, proposalTargets: state.proposalTargets })
          : hasProposalGrounding(incoming.kind, references);
        if (ready) {
          nextPhase = 'propose';
        } else {
          const target: Phase = hasLiveReference(references) || candidates.length > 0 ? 'select' : 'discover';
          const current = groundPhase(state.phase, grounded);
          nextPhase = PHASE_RANK[target] > PHASE_RANK[current] ? target : current;
        }
      } else if (event.suggestedPhase) {
        // Continuing the same request may only move forward. A lexical hint must never
        // undo grounding the conversation already earned: "download the 1080p one" said
        // `discover`, which would have thrown away the release the user just picked.
        const suggested = groundPhase(event.suggestedPhase, grounded);
        const current = groundPhase(state.phase, grounded);
        nextPhase = PHASE_RANK[suggested] > PHASE_RANK[current] ? suggested : current;
      } else if (!hasLiveReference(references) && state.phase !== 'monitor' && state.phase !== 'maintain') {
        nextPhase = groundPhase(state.phase, grounded);
      }

      return {
        ...state,
        phase: nextPhase,
        intent,
        references,
        candidates,
        updatedAt: now,
      };
    }

    case 'typed_selection': {
      // AGT-05: Only verified typed selections from the server channel enter here
      const sel = event.selection;
      const newRefs: WorkflowReferences = referencesExpired(state.references, now) ? {} : { ...state.references };
      let touched = false;

      if (isValidMediaRef(sel.mediaRef)) {
        const media = sel.mediaRef!.trim();
        // Choosing another entity drops what was derived for the previous one. So does
        // choosing a media without a release (select_candidate), even the one in focus
        // (review finding D4): after cards for Eclipse 2004 and 2017, a read of the 2017
        // releases left the focus on 2004, and a click on 2004 kept the 2017 releaseRef
        // grounded, so propose_download stayed reachable for the film not chosen. A
        // select_release keeps its releaseRef: it is set again just below.
        if (newRefs.mediaRef !== media || !isValidReleaseRef(sel.releaseRef)) clearDerived(newRefs);
        newRefs.mediaRef = media;
        newRefs.mediaRefs = mergeBounded(newRefs.mediaRefs, [media], REFERENCE_LIMITS.mediaRefs);
        touched = true;
      }
      if (isValidReleaseRef(sel.releaseRef)) {
        const release = sel.releaseRef!.trim();
        newRefs.releaseRef = release;
        newRefs.releaseRefs = mergeBounded(newRefs.releaseRefs, [release], REFERENCE_LIMITS.releaseRefs);
        touched = true;
      }
      if (touched) {
        newRefs.expiresAt = refsExpiry(clock);
      }

      // Selecting a release through the verified channel explicitly requests a
      // download proposal; free-form selection text never supplies this intent.
      const releaseChosen = (sel.type === 'select_release' || sel.type === 'propose_download') && isValidReleaseRef(sel.releaseRef);
      const intent: WorkflowIntent | undefined = releaseChosen
        ? { ...state.intent, kind: 'download', summary: state.intent?.summary ?? 'Selected release' }
        : state.intent;
      const nextPhase = groundPhase('propose', { ...state, references: newRefs, intent });

      return {
        ...state,
        phase: nextPhase,
        intent,
        references: newRefs,
        selections: [...state.selections, sel].slice(-8),
        updatedAt: now,
      };
    }

    case 'tool_result': {
      const callEntry: ToolCallDigest = {
        tool: event.tool,
        argsHash: event.argsHash,
        resultDigest: event.resultDigest,
        at: now,
      };
      // Keep a sliding window of the last 8 tool calls
      const updatedCalls = [...state.lastToolCalls, callEntry].slice(-8);

      // Defense in depth: even though the runtime only forwards references from
      // tools entitled to mint them, the reducer re-validates their shape (§2.7).
      const incoming = event.references ?? {};
      const before: WorkflowReferences = referencesExpired(state.references, now) ? {} : state.references;
      const nextRefs: WorkflowReferences = { ...before };
      let touched = false;

      const media = unique([incoming.mediaRef ?? '', ...(incoming.mediaRefs ?? [])].filter(isValidMediaRef).map(ref => ref.trim()));
      if (media.length > 0) {
        const known = observedMediaRefs(nextRefs);
        // A read that resolves a different entity drops what was derived for the old one.
        if (known.length > 0 && !media.some(ref => known.includes(ref))) clearDerived(nextRefs);
        if (!nextRefs.mediaRef || !media.includes(nextRefs.mediaRef)) nextRefs.mediaRef = media[0];
        nextRefs.mediaRefs = mergeBounded(nextRefs.mediaRefs, media, REFERENCE_LIMITS.mediaRefs);
        touched = true;
      }
      const releases = unique([incoming.releaseRef ?? '', ...(incoming.releaseRefs ?? [])].filter(isValidReleaseRef).map(ref => ref.trim()));
      if (releases.length > 0) {
        nextRefs.releaseRef = releases[0];
        nextRefs.releaseRefs = mergeBounded(nextRefs.releaseRefs, releases, REFERENCE_LIMITS.releaseRefs);
        touched = true;
      }
      // Listings and analyses accumulate: each file stays an exact, verified target
      // until the TTL or a new subject clears it. Only observed files can be proposed.
      const paths = (incoming.paths ?? []).filter(isReferencePath);
      if (paths.length > 0) {
        nextRefs.paths = mergeBounded(nextRefs.paths, paths, REFERENCE_LIMITS.paths, canonicalPathKey);
        touched = true;
      }
      const inspected = (incoming.inspectedPaths ?? []).filter(isReferencePath);
      if (inspected.length > 0) {
        nextRefs.inspectedPaths = mergeBounded(nextRefs.inspectedPaths, inspected, REFERENCE_LIMITS.inspectedPaths, canonicalPathKey);
        touched = true;
      }
      if (touched) {
        nextRefs.expiresAt = refsExpiry(clock);
      }

      const kind = state.intent?.kind;
      let nextPhase = state.phase;
      if (state.phase === 'monitor') {
        // After a plan, only a newly observed target that no plan proposed offers
        // another proposal. Reading the same results again keeps monitoring.
        if (newUnproposedGrounding(kind, before, nextRefs, state)) nextPhase = 'propose';
      } else if (state.phase !== 'maintain') {
        if (hasProposalGrounding(kind, nextRefs)) nextPhase = 'propose';
        else if (state.phase === 'propose') nextPhase = groundPhase('propose', { ...state, references: nextRefs });
        else if ((state.phase === 'discover' || state.phase === 'orient') && hasLiveReference(nextRefs) &&
          !(kind && READ_INTENTS.has(kind))) {
          nextPhase = 'select';
        }
      }

      return {
        ...state,
        phase: nextPhase,
        lastToolCalls: updatedCalls,
        references: nextRefs,
        updatedAt: now,
      };
    }

    case 'candidates_presented': {
      const candidates = event.candidates
        .filter(c => c && typeof c.label === 'string')
        .slice(0, 8)
        .map(c => ({
          label: clampSummary(c.label).slice(0, 160),
          ...(isValidMediaRef(c.mediaRef) ? { mediaRef: c.mediaRef!.trim() } : {}),
          ...(isValidReleaseRef(c.releaseRef) ? { releaseRef: c.releaseRef!.trim() } : {}),
        }));

      return {
        ...state,
        candidates,
        phase: candidates.length > 0 && state.phase === 'discover' ? 'select' : state.phase,
        updatedAt: now,
      };
    }

    case 'proposal_created': {
      const record: ProposalRecord = {
        planId: event.planId,
        operation: event.operation,
        status: event.status,
        manifestHash: event.manifestHash,
        proposalKey: event.proposalKey,
      };
      const proposals = [...state.proposals.filter(p => p.planId !== event.planId), record].slice(-16);
      const targets = event.targets?.filter(target => typeof target === 'string' && target.length > 0).slice(0, REFERENCE_LIMITS.paths);
      const proposalTargets: Record<string, string[]> = {};
      for (const proposal of proposals) {
        const known = proposal.planId === event.planId ? targets : state.proposalTargets?.[proposal.planId];
        if (known) proposalTargets[proposal.planId] = known;
      }
      return {
        ...state,
        phase: 'monitor',
        proposals,
        proposalTargets,
        updatedAt: now,
      };
    }

    case 'operation_status': {
      const updatedProposals = state.proposals.map(p =>
        p.planId === event.planId ? { ...p, status: event.status } : p,
      );
      return {
        ...state,
        proposals: updatedProposals,
        updatedAt: now,
      };
    }

    case 'phase_transition': {
      return {
        ...state,
        phase: groundPhase(event.to, state),
        updatedAt: now,
      };
    }

    case 'calibration': {
      return {
        ...state,
        calibration: { ...event.calibration },
        updatedAt: now,
      };
    }

    case 'turn_ended': {
      // Expired references stop grounding the phase; the next turn starts from orient.
      const expired = referencesExpired(state.references, now);
      const references = expired ? {} : state.references;
      const candidates = expired ? [] : state.candidates;

      let nextPhase = state.phase;
      if (!hasLiveReference(references) && candidates.length === 0) {
        if (state.phase !== 'monitor' && state.phase !== 'maintain') {
          nextPhase = 'orient';
        }
      }

      return {
        ...state,
        phase: nextPhase,
        references,
        candidates,
        turn: state.turn + 1,
        budgetSnapshot: event.budgetSnapshot ?? state.budgetSnapshot,
        updatedAt: now,
      };
    }

    case 'reset': {
      // AGT-06: A conversation reset clears the workflow state and references,
      // but preserves the persisted plans in the store.
      return createInitialWorkflowState(
        state.conversationId,
        state.principalId,
        state.installationId,
        clock,
      );
    }

    default:
      // Unknown events do not mutate state
      return state;
  }
}

/** Workflow state store contract */
export interface WorkflowStore {
  get(conversationId: string): Promise<WorkflowState | null> | WorkflowState | null;
  set(conversationId: string, state: WorkflowState): Promise<void> | void;
  delete(conversationId: string): Promise<void> | void;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private map = new Map<string, WorkflowState>();

  get(conversationId: string): WorkflowState | null {
    const s = this.map.get(conversationId);
    return s ? JSON.parse(JSON.stringify(s)) : null;
  }

  set(conversationId: string, state: WorkflowState): void {
    this.map.set(conversationId, JSON.parse(JSON.stringify(state)));
  }

  delete(conversationId: string): void {
    this.map.delete(conversationId);
  }

  clear(): void {
    this.map.clear();
  }
}
