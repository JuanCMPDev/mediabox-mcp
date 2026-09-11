/* ─── Replay Scorer and Determinism Validator ──────────────────────────────
 * Evaluates event sequences, ledger effects, and state determinism (§2.11).
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatEvent } from '@mediabox/contracts';
import type { ReplayScenarioSpec, ExpectedEventMatcher, ReplayTurnExpected } from './types.js';
import type { WorkflowState, WorkflowStore } from '../workflow.js';
import type { LedgerEntry } from './fake-mcp.js';
import { AgentRuntime } from '../runtime.js';
import { ScriptedProvider } from './scripted-provider.js';
import { FakeMcp } from './fake-mcp.js';
import { InMemoryWorkflowStore, defaultClock } from '../workflow.js';
import { InMemoryHistoryStore } from '../../history.js';

export interface TurnExecutionResult {
  events: ChatEvent[];
  ledger: LedgerEntry[];
  state: WorkflowState;
}

export interface ScenarioExecutionResult {
  scenarioId: string;
  turns: TurnExecutionResult[];
}

export function extractNormalizedEvents(events: ChatEvent[]): Array<Record<string, unknown>> {
  return events
    .filter(e => ['phase', 'tool-start', 'tool-end', 'guard', 'choices', 'done'].includes(e.type))
    .map(e => {
      switch (e.type) {
        case 'phase':
          return { type: 'phase', phase: e.phase, reason: e.reason };
        case 'tool-start':
          return { type: 'tool-start', name: e.name };
        case 'tool-end':
          return { type: 'tool-end', name: e.name, ok: e.ok, error: e.error ? true : undefined };
        case 'guard':
          return { type: 'guard', code: e.code };
        case 'choices':
          return { type: 'choices', count: e.items.length };
        case 'done':
          return { type: 'done' };
        default:
          return { type: e.type };
      }
    });
}

export class ScenarioRunner {
  static async runScenario(
    spec: ReplayScenarioSpec,
    fakeMcpInstance?: FakeMcp,
  ): Promise<ScenarioExecutionResult> {
    const conversationId = `conv_${spec.id}`;
    const workflowStore: WorkflowStore = new InMemoryWorkflowStore();
    const historyStore = new InMemoryHistoryStore();
    const mcp = fakeMcpInstance ?? new FakeMcp();

    if (spec.initialState) {
      await workflowStore.set(conversationId, spec.initialState as WorkflowState);
    }

    const turnsResults: TurnExecutionResult[] = [];

    for (let i = 0; i < spec.turns.length; i++) {
      const turn = spec.turns[i];
      if (turn.mcp) {
        mcp.addFixtures(turn.mcp);
      }

      const provider = new ScriptedProvider(turn.provider);
      const turnEvents: ChatEvent[] = [];
      const ledgerBefore = mcp.ledger.length;

      const stream = AgentRuntime.streamTurn({
        conversationId,
        message: turn.user,
        selection: turn.selection,
        provider,
        mcpCall: mcp.callFn,
        historyStore,
        workflowStore,
        locale: spec.locale ?? 'en',
        clock: defaultClock,
      });

      for await (const event of stream) {
        turnEvents.push(event);
      }

      const turnLedger = mcp.ledger.slice(ledgerBefore);
      const finalState = (await workflowStore.get(conversationId))!;

      turnsResults.push({
        events: turnEvents,
        ledger: turnLedger,
        state: finalState,
      });
    }

    return {
      scenarioId: spec.id,
      turns: turnsResults,
    };
  }

  /**
   * Asserts expectations on a turn result according to the scenario specification.
   */
  static scoreTurn(result: TurnExecutionResult, expected?: ReplayTurnExpected): void {
    if (!expected) return;

    if (expected.events) {
      for (const exp of expected.events) {
        const found = result.events.find(e => {
          if (e.type !== exp.type) return false;
          if (exp.phase && (e as any).phase !== exp.phase) return false;
          if (exp.code && (e as any).code !== exp.code) return false;
          if (exp.name && (e as any).name !== exp.name) return false;
          if (exp.ok !== undefined && (e as any).ok !== exp.ok) return false;
          return true;
        });

        if (!found) {
          throw new Error(
            `Expected event of type '${exp.type}' with details ${JSON.stringify(exp)} not found in events: ${JSON.stringify(result.events)}`,
          );
        }
      }
    }

    if (expected.guardCode) {
      const guardEvent = result.events.find(e => e.type === 'guard' && (e as any).code === expected.guardCode);
      if (!guardEvent) {
        throw new Error(`Expected guard event with code '${expected.guardCode}', but got none`);
      }
    }

    if (expected.ledger) {
      if (result.ledger.length !== expected.ledger.length) {
        throw new Error(
          `Expected ${expected.ledger.length} tool calls in ledger, but got ${result.ledger.length}: ${JSON.stringify(result.ledger)}`,
        );
      }
      for (let i = 0; i < expected.ledger.length; i++) {
        const expCall = expected.ledger[i];
        const actualCall = result.ledger[i];
        if (actualCall.tool !== expCall.tool) {
          throw new Error(`Expected ledger tool '${expCall.tool}', got '${actualCall.tool}' at index ${i}`);
        }
      }
    }

    if (expected.state) {
      for (const [key, value] of Object.entries(expected.state)) {
        const actualVal = (result.state as any)[key];
        if (JSON.stringify(actualVal) !== JSON.stringify(value)) {
          throw new Error(
            `State mismatch for key '${key}': expected ${JSON.stringify(value)}, got ${JSON.stringify(actualVal)}`,
          );
        }
      }
    }
  }

  /**
   * Compares two execution runs for strict determinism (§2.11).
   */
  static assertDeterministic(runA: ScenarioExecutionResult, runB: ScenarioExecutionResult): void {
    if (runA.turns.length !== runB.turns.length) {
      throw new Error(`Non-deterministic turn count: ${runA.turns.length} vs ${runB.turns.length}`);
    }

    for (let i = 0; i < runA.turns.length; i++) {
      const normA = extractNormalizedEvents(runA.turns[i].events);
      const normB = extractNormalizedEvents(runB.turns[i].events);

      if (JSON.stringify(normA) !== JSON.stringify(normB)) {
        throw new Error(
          `Non-deterministic events in turn ${i}:\nRun A: ${JSON.stringify(normA)}\nRun B: ${JSON.stringify(normB)}`,
        );
      }

      const ledgerA = runA.turns[i].ledger.map(l => ({ tool: l.tool, args: l.args }));
      const ledgerB = runB.turns[i].ledger.map(l => ({ tool: l.tool, args: l.args }));

      if (JSON.stringify(ledgerA) !== JSON.stringify(ledgerB)) {
        throw new Error(
          `Non-deterministic ledger in turn ${i}:\nRun A: ${JSON.stringify(ledgerA)}\nRun B: ${JSON.stringify(ledgerB)}`,
        );
      }

      if (runA.turns[i].state.phase !== runB.turns[i].state.phase) {
        throw new Error(
          `Non-deterministic phase in turn ${i}: ${runA.turns[i].state.phase} vs ${runB.turns[i].state.phase}`,
        );
      }
    }
  }
}
