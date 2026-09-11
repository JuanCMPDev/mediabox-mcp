/* ─── Replay Types and Scenario Definitions ─────────────────────────────────
 * Declarative scenario format for deterministic replay testing (§2.11 / AGT-01..12).
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatEvent, Phase, TypedSelection } from '@mediabox/contracts';
import type { LLMStreamChunk } from '../../providers/types.js';
import type { WorkflowState } from '../workflow.js';

export interface ExpectedEventMatcher {
  type: ChatEvent['type'];
  phase?: Phase;
  code?: string;
  name?: string;
  ok?: boolean;
}

export interface ReplayTurnExpected {
  events?: ExpectedEventMatcher[];
  ledger?: Array<{ tool: string; args?: Record<string, unknown> }>;
  state?: Partial<WorkflowState>;
  guardCode?: string;
}

export interface ReplayTurnSpec {
  user?: string;
  selection?: TypedSelection;
  provider: LLMStreamChunk[][]; // Array of chunks per inference step in the turn
  mcp?: Record<string, string>; // Map of toolName -> fixture JSON string
  expect?: ReplayTurnExpected;
}

export interface ReplayScenarioSpec {
  id: string;
  title: string;
  locale?: 'en' | 'es';
  initialState?: Partial<WorkflowState>;
  turns: ReplayTurnSpec[];
}
