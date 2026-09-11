import { describe, it, expect } from 'vitest';
import { redactSecrets, redactTrace, type AgentTrace } from './trace.js';

describe('Turn Trace & Secret Redaction (§2.10 / AGT-10)', () => {
  it('redacts bearer tokens, API keys, passwords, and truncates full references', () => {
    const raw = 'Auth Bearer eyJhbGciOiJIUzI1NiJ9.test and sk-or-v1-abcdef0123456789 and AIzaSyD1234567890123456789012345678901 with mref_a1b2c3d4e5f6';
    const redacted = redactSecrets(raw);

    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9.test');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).not.toContain('sk-or-v1-abcdef0123456789');
    expect(redacted).toContain('sk-[REDACTED]');
    expect(redacted).not.toContain('AIzaSyD1234567890123456789012345678901');
    expect(redacted).toContain('AIza[REDACTED]');
    expect(redacted).toContain('mref_a1b2...');
    expect(redacted).not.toContain('mref_a1b2c3d4e5f6');
  });

  it('redacts structured AgentTrace objects completely (AGT-10)', () => {
    const trace: AgentTrace = {
      turnId: 'turn_1',
      conversationId: 'conv_1',
      provider: 'local',
      model: 'qwen2.5:7b',
      initialPhase: 'orient',
      finalPhase: 'select',
      inferences: [
        {
          step: 1,
          estimatedPromptTokens: 100,
          durationMs: 50,
        },
      ],
      toolCalls: [
        {
          tool: 'catalog',
          ok: true,
          durationMs: 40,
        },
      ],
      guardDecisions: ['Allowed: used mref_deadbeef1234 with apiKey sk-1234567890abcdef'],
      budgetUsed: { inputEstimated: 100, outputReserve: 1024 },
      proposalKeys: ['prop_key_1'],
      createdAt: '2026-09-11T00:00:00.000Z',
    };

    const clean = redactTrace(trace);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain('mref_deadbeef1234');
    expect(serialized).toContain('mref_dead...');
    expect(serialized).not.toContain('sk-1234567890abcdef');
    expect(serialized).toContain('sk-[REDACTED]');
  });
});
