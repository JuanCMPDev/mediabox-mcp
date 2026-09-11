import { describe, it, expect } from 'vitest';
import { buildSystemPromptForPhase, type PromptLocale } from '../prompt.js';
import type { Phase } from '@mediabox/contracts';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const PHASES: Phase[] = ['orient', 'discover', 'select', 'propose', 'monitor', 'maintain'];
const LOCALES: PromptLocale[] = ['en', 'es'];

describe('System prompt phase token bounds (§2.4 / AGT-02)', () => {
  for (const locale of LOCALES) {
    for (const phase of PHASES) {
      it(`keeps system prompt for (${locale}, ${phase}) <= 1400 tokens`, () => {
        const prompt = buildSystemPromptForPhase(locale, phase);
        const tokens = estimateTokens(prompt);
        expect(tokens).toBeLessThanOrEqual(1400);
      });
    }
  }
});
