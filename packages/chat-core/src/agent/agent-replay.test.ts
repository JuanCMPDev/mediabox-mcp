/* ─── Agent Replay and Determinism Test Suite (Gate G07) ─────────────────────
 * Runs the 12 acceptance scenarios (AGT-01..12) with double-pass determinism
 * verification. Every turn of every scenario is additionally checked for the
 * budget and tool-count invariants and for unexpected MCP calls.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReplayScenarioSpec } from './replay/types.js';
import { ScenarioRunner } from './replay/scorer.js';
import { getPhaseTools, ALL_PHASES, FORBIDDEN_ACTIONS } from './phases.js';
import { TokenCounter } from './tokenizer.js';
import { PRESENT_CHOICES_TOOL } from '../virtual-tools.js';
import { SYSTEM_PROMPT_TOKEN_CAP, TOOL_SCHEMA_TOKEN_CAP, estimateTokenCount } from './budget.js';
import { buildSystemPromptForPhase } from '../prompt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadScenario(filename: string): ReplayScenarioSpec {
  const fullPath = resolve(__dirname, 'replay', 'scenarios', filename);
  return JSON.parse(readFileSync(fullPath, 'utf-8')) as ReplayScenarioSpec;
}

const SCENARIO_FILES = [
  'agt-01-validation.json',
  'agt-02-budget-long-history.json',
  'agt-03-loop-detection.json',
  'agt-04-adversarial-injection.json',
  'agt-05-typed-selection.json',
  'agt-06-reset-model-switch.json',
  'agt-07-context-overflow.json',
  'agt-08-duplicate-proposal.json',
  'agt-09-cancellation.json',
  'agt-10-trace-redaction.json',
  'agt-11-tool-count-per-phase.json',
  'agt-12-counter-calibration.json',
];

describe('Gate G07: Deterministic Agent Replay Scenarios (AGT-01..12)', () => {
  for (const file of SCENARIO_FILES) {
    it(`executes ${file} deterministically in double pass`, async () => {
      const spec = loadScenario(file);

      const run1 = await ScenarioRunner.runScenario(spec);
      for (let i = 0; i < spec.turns.length; i++) {
        ScenarioRunner.scoreTurn(run1.turns[i], spec.turns[i].expect);
      }
      ScenarioRunner.assertPlansUntouched(spec, run1);

      // Second pass certifies determinism of events, ledger, state and turn id (§2.11)
      const run2 = await ScenarioRunner.runScenario(spec);
      ScenarioRunner.assertDeterministic(run1, run2);
    });
  }

  it('AGT-02: a long history is compacted into digests and every inference fits the budget', async () => {
    const spec = loadScenario('agt-02-budget-long-history.json');
    const result = await ScenarioRunner.runScenario(spec);

    const lastTurn = result.turns.at(-1)!;
    const lastPrompt = lastTurn.prompts.at(-1)!;
    const serialisedResults = lastPrompt.messages
      .flatMap(m => m.toolResults ?? [])
      .map(r => r.result);

    // Results from older turns collapse to a digest line…
    expect(serialisedResults.some(r => r.startsWith('[tool_digest'))).toBe(true);
    // …and the recent ones arrive inside a well formed data boundary.
    const recent = serialisedResults.find(r => r.startsWith('[tool_result'))!;
    expect(recent).toMatch(/^\[tool_result tool=catalog status=ok source=search_media\]/);
    expect(recent.trimEnd().endsWith('[/tool_result]')).toBe(true);

    // No single result carries more than five items even though the fixture has thirty.
    const payload = JSON.parse(recent.split('\n').slice(1, -1).join('\n'));
    expect(payload.data).toHaveLength(5);
    expect(payload.totalCount).toBe(30);

    for (const turn of result.turns) {
      const budget = turn.trace!.budgetUsed.inputBudget!;
      for (const inf of turn.trace!.inferences) {
        expect(inf.estimatedPromptTokens).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('AGT-04: adversarial payloads never reach the state, the phase or the tool catalog', async () => {
    const spec = loadScenario('agt-04-adversarial-injection.json');
    const result = await ScenarioRunner.runScenario(spec);

    const [first, second] = result.turns;
    expect(first.state.phase).toBe('select');
    expect(first.state.references.releaseRef).toBeUndefined(); // forged ref refused
    expect(first.state.proposals).toHaveLength(0);
    expect(second.state.proposals).toHaveLength(0);

    // The hostile payload reached the model only inside the envelope, with its
    // markers neutralised and its control characters gone.
    const fed = first.prompts[1].messages.flatMap(m => m.toolResults ?? [])[0].result;
    expect(fed.match(/\[\/tool_result\]/g)).toHaveLength(1);
    expect(fed).toContain('(tool_result');

    for (const turn of result.turns) {
      for (const entry of turn.ledger) {
        expect(entry.tool).not.toMatch(/delete|approve|purge|cleanup/);
      }
    }
  });

  it('AGT-06: after a reset the state is fresh, the transcript is empty and the plan is still queryable', async () => {
    const spec = loadScenario('agt-06-reset-model-switch.json');
    const result = await ScenarioRunner.runScenario(spec);

    const afterReset = result.turns[1];
    expect(afterReset.state.references).toEqual({});
    expect(afterReset.state.proposals).toEqual([]);
    expect(afterReset.state.turn).toBe(1); // counting restarted
    // The plan itself is untouched and still answers through operation_status.
    expect(afterReset.ledger.map(l => l.tool)).toEqual(['operation_status']);
    expect(result.plans).toEqual(spec.preservedPlans);
    // A different model in the same conversation changes nothing in the state shape.
    expect(result.turns[0].trace!.model).toBe('qwen2.5:7b');
    expect(afterReset.trace!.model).toBe('gemma-3-12b');
  });

  it('AGT-09: the cancelled turn persisted its state and issued no further inference', async () => {
    const spec = loadScenario('agt-09-cancellation.json');
    const result = await ScenarioRunner.runScenario(spec);
    const turn = result.turns[0];

    expect(turn.state).not.toBeNull();
    expect(turn.state.turn).toBe(1);
    expect(turn.prompts).toHaveLength(1);
    expect(turn.events.at(-1)).toMatchObject({ type: 'error', code: 'ERR_CANCELLED' });
    expect(result.plans).toEqual(spec.preservedPlans);
  });

  it('AGT-10: the emitted trace contains no secret, reference or payload from the turn', async () => {
    const spec = loadScenario('agt-10-trace-redaction.json');
    const result = await ScenarioRunner.runScenario(spec);
    const trace = result.turns[0].trace!;
    const serialized = JSON.stringify(trace);

    expect(serialized).not.toContain('super-secret-token-xyz');
    expect(serialized).not.toContain('sk-or-v1-abcdef0123456789');
    expect(serialized).not.toContain('mref_1234567890ab');
    expect(serialized).not.toContain('Winden');
    // What it does carry: counters, phases and tool outcomes.
    expect(trace.toolCalls[0]).toMatchObject({ tool: 'catalog', ok: true });
    expect(trace.inferences.length).toBeGreaterThan(0);
    expect(trace.budgetUsed.inputBudget).toBeGreaterThan(0);
  });

  it('AGT-11: every phase stays within four virtual tools, prompt and schema caps', () => {
    for (const phase of ALL_PHASES) {
      const tools = getPhaseTools(phase);
      const regularTools = tools.filter(t => t.name !== PRESENT_CHOICES_TOOL);
      expect(regularTools.length).toBeLessThanOrEqual(4);
      expect(tools.some(t => t.name === PRESENT_CHOICES_TOOL)).toBe(true);
      expect(estimateTokenCount(JSON.stringify(tools))).toBeLessThanOrEqual(TOOL_SCHEMA_TOKEN_CAP);

      for (const locale of ['en', 'es'] as const) {
        expect(estimateTokenCount(buildSystemPromptForPhase(locale, phase))).toBeLessThanOrEqual(
          SYSTEM_PROMPT_TOKEN_CAP,
        );
      }

      // No phase may offer an approval, cancellation or administration action.
      const offered = tools.flatMap(t => ((t.parameters as any)?.properties?.action?.enum as string[]) ?? []);
      for (const action of offered) {
        expect(FORBIDDEN_ACTIONS.has(action)).toBe(false);
      }
    }
  });

  it('AGT-12: calibration is applied to the estimate and carried into the next turn', async () => {
    const spec = loadScenario('agt-12-counter-calibration.json');
    const result = await ScenarioRunner.runScenario(spec);

    // Turn 1 measured a deviation above 25% → margin armed and persisted.
    expect(result.turns[0].state.calibration).toEqual({
      factor: 3.5,
      extraMargin: 0.15,
      consecutiveDeviations: 1,
    });
    // Turn 2 starts from it, so the margin is already applied to its own estimate…
    expect(result.turns[1].trace!.inferences[0].counterExtraMargin).toBe(0.15);
    // …and the second consecutive deviation recalibrated the characters-per-token factor.
    expect(result.turns[1].state.calibration!.factor).toBeLessThan(3.5);

    const counter = TokenCounter.fromCalibration(result.turns[1].state.calibration);
    expect(counter.estimate('a'.repeat(350))).toBeGreaterThan(Math.ceil(350 / 3.5));
  });
});
