/* ─── Replay Types and Scenario Definitions ─────────────────────────────────
 * Declarative scenario format for deterministic replay testing (§2.11 / AGT-01..12).
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatEvent, Phase, TypedSelection } from '@mediabox/contracts';
import type { WorkflowState } from '../workflow.js';
import type { ScriptedInference } from './scripted-provider.js';

export interface ExpectedEventMatcher {
  type: ChatEvent['type'];
  phase?: Phase;
  code?: string;
  name?: string;
  ok?: boolean;
}

export interface ReplayTurnExpected {
  /** Matched as an ordered subsequence of the emitted events. */
  events?: ExpectedEventMatcher[];
  ledger?: Array<{ tool: string; args?: Record<string, unknown> }>;
  state?: Partial<WorkflowState>;
  guardCode?: string;
  /** Tool names that must never appear in any inference of the turn. */
  forbiddenTools?: string[];
  /** Action enum values that must never be offered to the model in this turn. */
  forbiddenActions?: string[];
  /** Number of inferences the provider was asked for. */
  inferences?: number;
}

export interface ReplayTurnSpec {
  user?: string;
  selection?: TypedSelection;
  /** One entry per inference: engine chunks, or raw SSE fragments to normalise. */
  provider: ScriptedInference[];
  /** Model name for this turn, to prove a model switch does not touch the state. */
  providerModel?: string;
  mcp?: Record<string, string>; // Map of toolName -> fixture JSON string
  /** Delay applied to fixture resolution, used together with `cancelOnToolStart`. */
  mcpDelayMs?: number;
  /** Aborts the turn when a tool-start event for this tool is emitted (AGT-09). */
  cancelOnToolStart?: string;
  /** Budget override for the turn. */
  budget?: { contextTokens: number; outputReserve: number; safetyMargin: number; inputBudget: number };
  expect?: ReplayTurnExpected;
}

export interface ReplayScenarioSpec {
  id: string;
  title: string;
  locale?: 'en' | 'es';
  initialState?: Partial<WorkflowState>;
  /** Plans that must survive the scenario untouched (AGT-06 / AGT-09). */
  preservedPlans?: Array<{ planId: string; operation: string; status: string }>;
  /** Resets the conversation before the listed turn index (AGT-06). */
  resetBeforeTurn?: number;
  turns: ReplayTurnSpec[];
}
