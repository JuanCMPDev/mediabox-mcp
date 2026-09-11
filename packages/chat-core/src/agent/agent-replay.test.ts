/* ─── Agent Replay and Determinism Test Suite (Gate G07) ─────────────────────
 * Runs the 12 acceptance scenarios (AGT-01..12) with double-pass determinism verification.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReplayScenarioSpec } from './replay/types.js';
import { ScenarioRunner } from './replay/scorer.js';
import { FakeMcp } from './replay/fake-mcp.js';
import { AgentRuntime } from './runtime.js';
import { ScriptedProvider } from './replay/scripted-provider.js';
import { InMemoryHistoryStore } from '../history.js';
import { InMemoryWorkflowStore, defaultClock } from './workflow.js';
import { getPhaseTools } from './phases.js';
import { TokenCounter } from './tokenizer.js';
import { redactTrace, type AgentTrace } from './trace.js';
import type { Phase } from '@mediabox/contracts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadScenario(filename: string): ReplayScenarioSpec {
  const fullPath = resolve(__dirname, 'replay', 'scenarios', filename);
  const raw = readFileSync(fullPath, 'utf-8');
  return JSON.parse(raw) as ReplayScenarioSpec;
}

describe('Gate G07: Deterministic Agent Replay Scenarios (AGT-01..12)', () => {
  const scenarioFiles = [
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

  for (const file of scenarioFiles) {
    it(`executes ${file} deterministically in double pass`, async () => {
      const spec = loadScenario(file);

      // Run 1
      const run1 = await ScenarioRunner.runScenario(spec);

      // Verify expectations on Run 1
      for (let i = 0; i < spec.turns.length; i++) {
        ScenarioRunner.scoreTurn(run1.turns[i], spec.turns[i].expect);
      }

      // Run 2 (Double pass to certify determinism §2.11)
      const run2 = await ScenarioRunner.runScenario(spec);

      // Certify exact determinism between Run 1 and Run 2
      ScenarioRunner.assertDeterministic(run1, run2);
    });
  }

  it('AGT-04: Adversarial fixtures cannot alter workflow phase, trigger proposals, or expose forbidden tools', async () => {
    const spec = loadScenario('agt-04-adversarial-injection.json');
    const result = await ScenarioRunner.runScenario(spec);

    const finalState = result.turns[0].state;
    // Phase should never transition to propose or monitor due to injection
    expect(finalState.phase).not.toBe('propose');
    expect(finalState.phase).not.toBe('monitor');
    expect(finalState.proposals).toHaveLength(0);

    // Ledger must not contain any destructive or unexposed calls
    for (const call of result.turns[0].ledger) {
      expect(call.tool).not.toBe('delete_media');
      expect(call.tool).not.toBe('library_ops');
    }
  });

  it('AGT-07: Context overflow throws ERR_CONTEXT_OVERFLOW before calling provider', async () => {
    const tinyBudget = {
      contextTokens: 1000,
      outputReserve: 800,
      safetyMargin: 200,
      inputBudget: 100, // Impossibly small budget for fixed prompt
    };

    const provider = new ScriptedProvider([[{ type: 'text', text: 'Should never run' }]]);
    const mcp = new FakeMcp();
    const workflowStore = new InMemoryWorkflowStore();
    const historyStore = new InMemoryHistoryStore();

    const events: any[] = [];
    for await (const evt of AgentRuntime.streamTurn({
      conversationId: 'conv_overflow',
      message: 'Hello',
      provider,
      mcpCall: mcp.callFn,
      historyStore,
      workflowStore,
      budget: tinyBudget,
    })) {
      events.push(evt);
    }

    const guardEvent = events.find(e => e.type === 'guard');
    expect(guardEvent).toBeDefined();
    expect(guardEvent?.code).toBe('ERR_CONTEXT_OVERFLOW');
    expect(provider.seen).toHaveLength(0); // Provider was never invoked
  });

  it('AGT-09: Turn cancellation aborts mid-flight and preserves state', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([[
      { type: 'tool_call', id: 'c1', name: 'catalog', args: { action: 'search', query: 'Dark', type: 'series' } },
    ]]);

    let called = false;
    const mcpCall = async () => {
      called = true;
      controller.abort();
      return '{"status":"ok"}';
    };

    const workflowStore = new InMemoryWorkflowStore();
    const historyStore = new InMemoryHistoryStore();

    const events: any[] = [];
    for await (const evt of AgentRuntime.streamTurn({
      conversationId: 'conv_cancel',
      message: 'Search Dark',
      provider,
      mcpCall,
      historyStore,
      workflowStore,
      signal: controller.signal,
    })) {
      events.push(evt);
    }

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe('ERR_CANCELLED');

    const state = await workflowStore.get('conv_cancel');
    expect(state).toBeDefined();
  });

  it('AGT-10: Trace redaction strips all secrets and truncates references', async () => {
    let capturedTrace: AgentTrace | undefined;
    const provider = new ScriptedProvider([
      [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'catalog',
          args: { action: 'search', query: 'Dark', type: 'series' },
        },
      ],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const mcp = new FakeMcp({
      search_media: '{"status":"ok","data":[{"id":"1","mediaRef":"mref_0123456789ab"}]}',
    });
    const workflowStore = new InMemoryWorkflowStore();
    const historyStore = new InMemoryHistoryStore();

    for await (const _ of AgentRuntime.streamTurn({
      conversationId: 'conv_trace',
      message: 'Search for Dark',
      provider,
      mcpCall: mcp.callFn,
      historyStore,
      workflowStore,
      onTrace: (t) => {
        t.guardDecisions.push('Bearer super-secret-token');
        t.guardDecisions.push('key: sk-or-v1-abcdef0123456789');
        t.guardDecisions.push('ref: mref_0123456789ab');
        capturedTrace = redactTrace(t);
      },
    })) {
      // consume
    }

    expect(capturedTrace).toBeDefined();
    const serialized = JSON.stringify(capturedTrace);
    expect(serialized).not.toContain('super-secret-token');
    expect(serialized).not.toContain('sk-or-v1-abcdef0123456789');
    expect(serialized).not.toContain('mref_0123456789ab');
    expect(serialized).toContain('mref_0123...');
  });

  it('AGT-11: Exposed virtual tools <= 4 plus present_choices across all 6 phases', () => {
    const phases: Phase[] = ['orient', 'discover', 'select', 'propose', 'monitor', 'maintain'];
    for (const phase of phases) {
      const tools = getPhaseTools(phase);
      const regularTools = tools.filter(t => t.name !== 'present_choices');
      expect(regularTools.length).toBeLessThanOrEqual(4);
      expect(tools.some(t => t.name === 'present_choices')).toBe(true);
    }
  });

  it('AGT-12: Token counter calibration applies extra margin upon > 25% deviation', () => {
    const counter = new TokenCounter(3.5);
    expect(counter.currentExtraMargin).toBe(0);

    // Prompt estimated at 100 tokens, real was 200 tokens (100% deviation)
    counter.calibrate(100, 200);
    expect(counter.currentExtraMargin).toBe(0.15);

    const normal = Math.ceil(350 / 3.5); // 100
    const withMargin = counter.estimate('a'.repeat(350));
    expect(withMargin).toBe(Math.ceil(normal * 1.15));
  });
});
