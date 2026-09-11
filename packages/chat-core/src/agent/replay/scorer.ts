/* ─── Replay Scorer and Determinism Validator ──────────────────────────────
 * Evaluates event sequences, ledger effects, and state determinism (§2.11).
 *
 * Three checks run on every scenario, not only where a scenario asks for them:
 *  - each inference stays inside the input budget (AGT-02)
 *  - each inference sees at most four virtual tools plus present_choices (AGT-11)
 *  - no unexpected MCP call was made (the dispatcher hides the throw from the caller)
 * ──────────────────────────────────────────────────────────────────────── */
import type { ChatEvent } from '@mediabox/contracts';
import type { ReplayScenarioSpec, ExpectedEventMatcher, ReplayTurnExpected } from './types.js';
import type { WorkflowState, WorkflowStore } from '../workflow.js';
import type { LedgerEntry } from './fake-mcp.js';
import type { AgentTrace } from '../trace.js';
import { AgentRuntime } from '../runtime.js';
import { ScriptedProvider, type PromptInspection } from './scripted-provider.js';
import { FakeMcp } from './fake-mcp.js';
import { InMemoryWorkflowStore, createInitialWorkflowState, reduce } from '../workflow.js';
import { InMemoryHistoryStore } from '../../history.js';
import { PRESENT_CHOICES_TOOL } from '../../virtual-tools.js';

/** Frozen clock: replays must not depend on wall time (§6.12). */
export const REPLAY_CLOCK = () => '2026-09-10T00:00:00.000Z';

const PLAN_MUTATING_TOOLS = /(approve|cancel|purge|execute|delete)/i;

export interface TurnExecutionResult {
  events: ChatEvent[];
  ledger: LedgerEntry[];
  state: WorkflowState;
  prompts: PromptInspection[];
  trace?: AgentTrace;
  unexpectedCalls: string[];
}

export interface ScenarioExecutionResult {
  scenarioId: string;
  turns: TurnExecutionResult[];
  /** Copy of the plans the scenario declared, proving nothing mutated them. */
  plans: Array<{ planId: string; operation: string; status: string }>;
}

export function extractNormalizedEvents(events: ChatEvent[]): Array<Record<string, unknown>> {
  return events
    .filter(e => ['phase', 'tool-start', 'tool-end', 'guard', 'choices', 'done'].includes(e.type))
    .map(e => {
      switch (e.type) {
        case 'phase':
          return { type: 'phase', phase: e.phase, reason: e.reason };
        case 'tool-start':
          return { type: 'tool-start', name: e.name, args: e.args };
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
    const plans = (spec.preservedPlans ?? []).map(p => ({ ...p }));

    if (spec.initialState) {
      const base = createInitialWorkflowState(conversationId, 'user', 'inst', REPLAY_CLOCK);
      await workflowStore.set(conversationId, { ...base, ...spec.initialState } as WorkflowState);
    }

    const turnsResults: TurnExecutionResult[] = [];

    for (let i = 0; i < spec.turns.length; i++) {
      const turn = spec.turns[i];

      if (spec.resetBeforeTurn === i) {
        // A reset clears transcript and state; plans live elsewhere and must survive.
        const current = (await workflowStore.get(conversationId)) ?? createInitialWorkflowState(conversationId, 'user', 'inst', REPLAY_CLOCK);
        await workflowStore.set(conversationId, reduce(current, { type: 'reset' }, REPLAY_CLOCK));
        historyStore.delete(conversationId);
      }

      if (turn.mcp) mcp.addFixtures(turn.mcp);
      mcp.setDelay(turn.mcpDelayMs ?? 0);

      const provider = new ScriptedProvider(turn.provider, turn.providerModel);
      const turnEvents: ChatEvent[] = [];
      const ledgerBefore = mcp.ledger.length;
      const unexpectedBefore = mcp.unexpectedCalls.length;
      let trace: AgentTrace | undefined;

      const controller = new AbortController();
      const stream = AgentRuntime.streamTurn({
        conversationId,
        message: turn.user,
        selection: turn.selection,
        provider,
        mcpCall: mcp.callFn,
        historyStore,
        workflowStore,
        locale: spec.locale ?? 'en',
        clock: REPLAY_CLOCK,
        signal: controller.signal,
        budget: turn.budget,
        onTrace: t => { trace = t; },
      });

      for await (const event of stream) {
        turnEvents.push(event);
        if (turn.cancelOnToolStart && event.type === 'tool-start' && event.name === turn.cancelOnToolStart) {
          controller.abort();
        }
      }

      const finalState = (await workflowStore.get(conversationId))!;

      turnsResults.push({
        events: turnEvents,
        ledger: mcp.ledger.slice(ledgerBefore),
        state: finalState,
        prompts: provider.seen,
        trace,
        unexpectedCalls: mcp.unexpectedCalls.slice(unexpectedBefore),
      });
    }

    return { scenarioId: spec.id, turns: turnsResults, plans };
  }

  /** Invariants asserted for every turn of every scenario. */
  static assertGlobalInvariants(result: TurnExecutionResult): void {
    if (result.unexpectedCalls.length > 0) {
      throw new Error(`Unexpected MCP calls were made: ${result.unexpectedCalls.join('; ')}`);
    }

    for (const [i, prompt] of result.prompts.entries()) {
      const regular = prompt.tools.filter(t => t.name !== PRESENT_CHOICES_TOOL);
      if (regular.length > 4) {
        throw new Error(
          `AGT-11: inference ${i + 1} exposed ${regular.length} virtual tools (${regular.map(t => t.name).join(', ')})`,
        );
      }
    }

    const inputBudget = result.trace?.budgetUsed.inputBudget;
    if (inputBudget !== undefined) {
      for (const inf of result.trace!.inferences) {
        if (inf.estimatedPromptTokens > inputBudget) {
          throw new Error(
            `AGT-02: inference ${inf.step} used ${inf.estimatedPromptTokens} tokens, above the input budget of ${inputBudget}`,
          );
        }
      }
    }
  }

  /**
   * Asserts expectations on a turn result according to the scenario specification.
   * Event expectations are matched in order, as a subsequence of the real stream.
   */
  static scoreTurn(result: TurnExecutionResult, expected?: ReplayTurnExpected): void {
    ScenarioRunner.assertGlobalInvariants(result);
    if (!expected) return;

    if (expected.events) {
      let cursor = 0;
      for (const exp of expected.events) {
        const index = result.events.findIndex((e, i) => i >= cursor && matchesEvent(e, exp));
        if (index === -1) {
          throw new Error(
            `Expected event ${JSON.stringify(exp)} after index ${cursor} not found in: ${JSON.stringify(
              extractNormalizedEvents(result.events),
            )}`,
          );
        }
        cursor = index + 1;
      }
    }

    if (expected.guardCode) {
      const guardEvent = result.events.find(e => e.type === 'guard' && (e as any).code === expected.guardCode);
      if (!guardEvent) {
        throw new Error(`Expected guard event with code '${expected.guardCode}', but got none`);
      }
    }

    if (expected.inferences !== undefined && result.prompts.length !== expected.inferences) {
      throw new Error(`Expected ${expected.inferences} inferences, got ${result.prompts.length}`);
    }

    if (expected.forbiddenTools) {
      for (const prompt of result.prompts) {
        for (const forbidden of expected.forbiddenTools) {
          if (prompt.tools.some(t => t.name === forbidden)) {
            throw new Error(`Tool '${forbidden}' must never be exposed in this turn`);
          }
        }
      }
      for (const entry of result.ledger) {
        if (expected.forbiddenTools.includes(entry.tool)) {
          throw new Error(`Tool '${entry.tool}' must never be called in this turn`);
        }
      }
    }

    if (expected.forbiddenActions) {
      for (const prompt of result.prompts) {
        const offered = prompt.tools.flatMap(
          t => ((t.parameters as any)?.properties?.action?.enum as string[] | undefined) ?? [],
        );
        for (const action of expected.forbiddenActions) {
          if (offered.includes(action)) {
            throw new Error(`Action '${action}' must never be offered to the model in this turn`);
          }
        }
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
        if (expCall.args && JSON.stringify(actualCall.args) !== JSON.stringify(expCall.args)) {
          throw new Error(
            `Ledger args mismatch at index ${i}: expected ${JSON.stringify(expCall.args)}, got ${JSON.stringify(actualCall.args)}`,
          );
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

  /** No plan-mutating tool may be reachable from the agent (§2.8). */
  static assertPlansUntouched(spec: ReplayScenarioSpec, result: ScenarioExecutionResult): void {
    for (const turn of result.turns) {
      for (const entry of turn.ledger) {
        if (PLAN_MUTATING_TOOLS.test(entry.tool) && !entry.tool.startsWith('propose_')) {
          throw new Error(`Agent reached a plan-mutating tool: ${entry.tool}`);
        }
      }
    }
    const expected = JSON.stringify(spec.preservedPlans ?? []);
    const actual = JSON.stringify(result.plans);
    if (expected !== actual) {
      throw new Error(`Declared plans changed during the scenario: ${actual}`);
    }
  }

  /**
   * Compares two execution runs for strict determinism (§2.11). With a frozen clock
   * the full state is comparable, not only the phase.
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

      if (JSON.stringify(runA.turns[i].state) !== JSON.stringify(runB.turns[i].state)) {
        throw new Error(
          `Non-deterministic state in turn ${i}:\nRun A: ${JSON.stringify(runA.turns[i].state)}\nRun B: ${JSON.stringify(runB.turns[i].state)}`,
        );
      }

      const traceA = runA.turns[i].trace;
      const traceB = runB.turns[i].trace;
      if (traceA?.turnId !== traceB?.turnId) {
        throw new Error(`Non-deterministic turnId in turn ${i}: ${traceA?.turnId} vs ${traceB?.turnId}`);
      }
    }
  }
}

function matchesEvent(e: ChatEvent, exp: ExpectedEventMatcher): boolean {
  if (e.type !== exp.type) return false;
  if (exp.phase && (e as any).phase !== exp.phase) return false;
  if (exp.code && (e as any).code !== exp.code) return false;
  if (exp.name && (e as any).name !== exp.name) return false;
  if (exp.ok !== undefined && (e as any).ok !== exp.ok) return false;
  return true;
}
