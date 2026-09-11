/* ─── Workflow State, Events and Reducer ────────────────────────────────────
 * Pure state reducer without I/O (§2.2 / AGT-05 / AGT-06).
 * ──────────────────────────────────────────────────────────────────────── */
import type { Phase, TypedSelection } from '@mediabox/contracts';
import { AgentError } from './errors.js';

export interface WorkflowIntent {
  kind: 'download' | 'delete' | 'convert' | 'inspect' | 'status' | 'other';
  summary: string;
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

export interface WorkflowState {
  schemaVersion: 1;
  conversationId: string;
  principalId: string;
  installationId: string;
  phase: Phase;
  intent?: WorkflowIntent;
  references: WorkflowReferences;
  selections: TypedSelection[];
  proposals: ProposalRecord[];
  lastToolCalls: ToolCallDigest[]; // window of 8
  budgetSnapshot?: BudgetSnapshot;
  turn: number;
  updatedAt: string;
}

export type WorkflowEvent =
  | { type: 'user_message'; text: string; intent?: WorkflowIntent }
  | { type: 'typed_selection'; selection: TypedSelection }
  | { type: 'tool_result'; tool: string; argsHash: string; resultDigest: string; references?: Partial<WorkflowReferences> }
  | { type: 'proposal_created'; planId: string; operation: string; status: string; manifestHash: string; proposalKey: string }
  | { type: 'operation_status'; planId: string; status: string }
  | { type: 'phase_transition'; to: Phase; reason: string }
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
    schemaVersion: 1,
    conversationId,
    principalId,
    installationId,
    phase: 'orient',
    references: {},
    selections: [],
    proposals: [],
    lastToolCalls: [],
    turn: 0,
    updatedAt: clock(),
  };
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
  if (state.schemaVersion !== 1) {
    throw new AgentError('ERR_WORKFLOW_CORRUPT', `Unsupported workflow schemaVersion: ${state.schemaVersion}`);
  }

  const now = clock();

  switch (event.type) {
    case 'user_message': {
      let nextPhase = state.phase;
      if (event.intent) {
        if (event.intent.kind === 'download' || event.intent.kind === 'delete' || event.intent.kind === 'convert') {
          if (state.phase === 'orient') nextPhase = 'discover';
        }
      }
      return {
        ...state,
        phase: nextPhase,
        intent: event.intent ?? state.intent,
        updatedAt: now,
      };
    }

    case 'typed_selection': {
      // AGT-05: Only verified typed selections from the server channel enter here
      const sel = event.selection;
      const newRefs: WorkflowReferences = { ...state.references };

      if (sel.mediaRef && /^[mr]ref_/.test(sel.mediaRef)) {
        newRefs.mediaRef = sel.mediaRef;
      }
      if (sel.releaseRef && /^rref_/.test(sel.releaseRef)) {
        newRefs.releaseRef = sel.releaseRef;
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
        selections: [...state.selections, sel],
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

      const nextRefs = event.references
        ? { ...state.references, ...event.references }
        : state.references;

      let nextPhase = state.phase;
      if (nextRefs.releaseRef && (state.phase === 'select' || state.phase === 'discover')) {
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
        proposals: [...state.proposals.filter(p => p.planId !== event.planId), record],
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
        phase: event.to,
        updatedAt: now,
      };
    }

    case 'turn_ended': {
      let nextPhase = state.phase;
      // If we finished turn in orient/maintain or have no active live references, stay/go to orient
      if (!state.references.mediaRef && !state.references.releaseRef && !state.references.paths?.length) {
        if (state.phase !== 'monitor') {
          nextPhase = 'orient';
        }
      }
      return {
        ...state,
        phase: nextPhase,
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
