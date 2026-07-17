import { describe, it, expect } from 'vitest';
import { resolveProvider } from './select.js';
import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';

describe('resolveProvider', () => {
  it("treats LLM_PROVIDER=google as the gemini provider (the generators' value)", () => {
    const p = resolveProvider({ LLM_PROVIDER: 'google', GOOGLE_AI_API_KEY: 'g-key' });
    expect(p).toBeInstanceOf(GeminiProvider);
    expect(p.providerName).toBe('gemini');
  });

  it('still accepts the canonical LLM_PROVIDER=gemini', () => {
    const p = resolveProvider({ LLM_PROVIDER: 'gemini', GOOGLE_AI_API_KEY: 'g-key' });
    expect(p).toBeInstanceOf(GeminiProvider);
  });

  it('is case/space tolerant on the provider name', () => {
    const p = resolveProvider({ LLM_PROVIDER: '  Google ', GOOGLE_AI_API_KEY: 'g-key' });
    expect(p).toBeInstanceOf(GeminiProvider);
  });

  it('resolves openrouter explicitly', () => {
    const p = resolveProvider({ LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key' });
    expect(p).toBeInstanceOf(OpenRouterProvider);
    expect(p.providerName).toBe('openrouter');
  });

  it('auto-detects gemini when only a google key is present', () => {
    const p = resolveProvider({ GOOGLE_AI_API_KEY: 'g-key' });
    expect(p).toBeInstanceOf(GeminiProvider);
  });

  it('auto-detects openrouter when only an openrouter key is present', () => {
    const p = resolveProvider({ OPENROUTER_API_KEY: 'or-key' });
    expect(p).toBeInstanceOf(OpenRouterProvider);
  });

  it('throws the gemini-specific error when google is selected without a key', () => {
    expect(() => resolveProvider({ LLM_PROVIDER: 'google' })).toThrowError(
      /GOOGLE_AI_API_KEY is required/,
    );
  });

  it('throws the openrouter error when openrouter is selected without a key', () => {
    expect(() => resolveProvider({ LLM_PROVIDER: 'openrouter' })).toThrowError(
      /OPENROUTER_API_KEY is required/,
    );
  });
});
