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

export interface WorkflowIntent {
  kind: 'download' | 'delete' | 'convert' | 'inspect' | 'status' | 'other';
  summary: string;
  /**
   * Significant subject words of the request (titles, names), with verbs and
   * quality words removed. Used to tell "next step of the same request" from
   * "a different request", which is what decides whether references survive.
   */
  subjects?: string[];
  constraints?: Array<{ key: string; value: unknown; strict?: boolean }>;
}

export interface WorkflowReferences {
  mediaRef?: string;
  releaseRef?: string;
  paths?: string[];
  expiresAt?: string;
}

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
  | { type: 'proposal_created'; planId: string; operation: string; status: string; manifestHash: string; proposalKey: string }
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
  return Boolean(refs.mediaRef || refs.releaseRef || refs.paths?.length);
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
export function groundPhase(target: Phase, state: Pick<WorkflowState, 'references' | 'candidates' | 'proposals'>): Phase {
  switch (target) {
    case 'propose':
      if (state.references.releaseRef || state.references.paths?.length) return 'propose';
      if (state.references.mediaRef || state.candidates.length > 0) return 'select';
      return 'discover';
    case 'select':
      if (state.references.mediaRef || state.candidates.length > 0) return 'select';
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
      const incoming = event.intent ? normalizeIntent(event.intent) : undefined;
      const previous = state.intent;

      // A fresh explicit request supersedes the previous one: its references stop
      // being valid, so the conversation can always return to discovery instead of
      // being pinned in select/propose forever.
      // A request supersedes the previous one only when it names a different
      // subject. Escalating within the same subject ("now download the 1080p one")
      // must keep the references the previous turns established.
      const startsNewRequest = Boolean(incoming) && introducesNewSubject(previous, incoming!, state.candidates);

      let references = state.references;
      let candidates = state.candidates;

      if (startsNewRequest) {
        references = {};
        candidates = [];
      } else if (referencesExpired(state.references, now)) {
        references = {};
        candidates = [];
      }

      const grounded = { references, candidates, proposals: state.proposals };
      let nextPhase = state.phase;
      if (startsNewRequest) {
        // A different subject starts over from the suggested entry phase.
        nextPhase = groundPhase(event.suggestedPhase ?? 'discover', grounded);
      } else if (event.suggestedPhase === 'maintain') {
        nextPhase = 'maintain';
      } else if (event.suggestedPhase) {
        // Continuing the same request may only move forward. A lexical hint must never
        // undo grounding the conversation already earned: "download the 1080p one" said
        // `discover`, which would have thrown away the release the user just picked.
        const suggested = groundPhase(event.suggestedPhase, grounded);
        nextPhase = PHASE_RANK[suggested] > PHASE_RANK[state.phase] ? suggested : state.phase;
      } else if (!hasLiveReference(references) && state.phase !== 'monitor' && state.phase !== 'maintain') {
        nextPhase = groundPhase(state.phase, grounded);
      }

      return {
        ...state,
        phase: nextPhase,
        intent: incoming ?? state.intent,
        references,
        candidates,
        updatedAt: now,
      };
    }

    case 'typed_selection': {
      // AGT-05: Only verified typed selections from the server channel enter here
      const sel = event.selection;
      const newRefs: WorkflowReferences = { ...state.references };
      let touched = false;

      if (isValidMediaRef(sel.mediaRef)) {
        newRefs.mediaRef = sel.mediaRef!.trim();
        touched = true;
      }
      if (isValidReleaseRef(sel.releaseRef)) {
        newRefs.releaseRef = sel.releaseRef!.trim();
        touched = true;
      }
      if (touched) {
        newRefs.expiresAt = refsExpiry(clock);
      }

      let nextPhase = state.phase;
      if (newRefs.releaseRef) {
        nextPhase = 'propose';
      } else if (newRefs.mediaRef) {
        nextPhase = 'select';
      }

      return {
        ...state,
        phase: nextPhase,
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
      const nextRefs: WorkflowReferences = { ...state.references };
      let touched = false;
      if (isValidMediaRef(incoming.mediaRef)) {
        nextRefs.mediaRef = incoming.mediaRef!.trim();
        touched = true;
      }
      if (isValidReleaseRef(incoming.releaseRef)) {
        nextRefs.releaseRef = incoming.releaseRef!.trim();
        touched = true;
      }
      if (Array.isArray(incoming.paths) && incoming.paths.length > 0) {
        nextRefs.paths = incoming.paths.slice(0, 20);
        touched = true;
      }
      if (touched) {
        nextRefs.expiresAt = refsExpiry(clock);
      }

      // Paths only unlock `propose` for intents that act on files; a plain listing
      // must not hand the model the proposal catalog.
      const pathIntent =
        state.intent?.kind === 'delete' || state.intent?.kind === 'convert' || state.intent?.kind === 'inspect';

      let nextPhase = state.phase;
      if (nextRefs.releaseRef && (state.phase === 'select' || state.phase === 'discover')) {
        nextPhase = 'propose';
      } else if (nextRefs.paths?.length && pathIntent && (state.phase === 'discover' || state.phase === 'select')) {
        nextPhase = 'propose';
      } else if (nextRefs.mediaRef && (state.phase === 'discover' || state.phase === 'orient')) {
        nextPhase = 'select';
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
      return {
        ...state,
        phase: 'monitor',
        proposals: [...state.proposals.filter(p => p.planId !== event.planId), record].slice(-16),
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
