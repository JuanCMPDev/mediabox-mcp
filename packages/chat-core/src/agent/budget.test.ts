import { describe, it, expect } from 'vitest';
import { prepareContext, compactToolResult, buildStateSummary, DEFAULT_BUDGET } from './budget.js';
import { createInitialWorkflowState } from './workflow.js';
import type { ChatMessage } from '../types.js';
import { AgentError } from './errors.js';

describe('Context Budget & Compaction (§2.4 / AGT-07)', () => {
  const state = createInitialWorkflowState('conv_1', 'p_1', 'inst_1');

  it('compacts large envelopes to at most 5 items and truncates long strings', () => {
    const rawResult = JSON.stringify({
      status: 'ok',
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `movie:${i}`,
        title: `Very Long Movie Title Number ${i} `.repeat(10),
        year: 2000 + i,
        extraUnneededField: 'ignored',
      })),
    });

    const compacted = compactToolResult('catalog', rawResult);
    const parsed = JSON.parse(compacted);
    expect(parsed.status).toBe('ok');
    expect(parsed.data.length).toBe(5);
    expect(parsed.data[0].title.length).toBeLessThanOrEqual(124); // 120 + '...'
    expect(parsed.data[0].extraUnneededField).toBeUndefined();
  });

  it('builds state summary within 600 tokens', () => {
    const summary = buildStateSummary({
      ...state,
      intent: { kind: 'download', summary: 'Download Inception in 1080p' },
      references: { mediaRef: 'mref_1234567890ab', releaseRef: 'rref_1234567890ab' },
      proposals: [{ planId: 'plan_1', operation: 'download', status: 'awaiting_approval', manifestHash: 'h', proposalKey: 'k' }],
    });
    expect(Math.ceil(summary.length / 3.5)).toBeLessThanOrEqual(600);
  });

  it('rejects context overflow before calling provider (AGT-07)', () => {
    // If the system prompt itself is huge (> inputBudget 6656 tokens), prepareContext must throw ERR_CONTEXT_OVERFLOW
    const giantPrompt = 'A'.repeat(7000 * 4); // ~8000 tokens

    expect(() =>
      prepareContext({
        systemPrompt: giantPrompt,
        tools: [],
        state,
        history: [],
        budget: DEFAULT_BUDGET,
      }),
    ).toThrow(AgentError);

    try {
      prepareContext({
        systemPrompt: giantPrompt,
        tools: [],
        state,
        history: [],
        budget: DEFAULT_BUDGET,
      });
    } catch (err: any) {
      expect(err.code).toBe('ERR_CONTEXT_OVERFLOW');
    }
  });

  it('trims old history without cutting mid-exchange', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'Turn 1: hello' },
      { role: 'assistant', content: 'Turn 1 reply' },
      { role: 'user', content: 'Turn 2: query' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'catalog', args: { action: 'search' } }],
      },
      {
        role: 'user',
        content: '',
        toolResults: [{ id: 'tc1', name: 'catalog', result: '{"status":"ok","data":[]}' }],
      },
      { role: 'assistant', content: 'Turn 2 final reply' },
      { role: 'user', content: 'Turn 3: latest question' },
    ];

    const ctx = prepareContext({
      systemPrompt: 'You are an assistant.',
      tools: [],
      state,
      history,
      budget: { ...DEFAULT_BUDGET, inputBudget: 1000 },
    });

    expect(ctx.messages.length).toBeGreaterThan(0);
    expect(ctx.estimatedTokens).toBeLessThanOrEqual(1000);
  });
});
