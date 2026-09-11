import { describe, it, expect } from 'vitest';
import { resolveProvider } from './select.js';
import { GeminiProvider } from './gemini.js';
import { OpenRouterProvider } from './openrouter.js';
import { LocalProvider } from './local.js';

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

  it('resolves local and ollama alias without needing api keys', () => {
    const p1 = resolveProvider({ LLM_PROVIDER: 'local' });
    expect(p1.providerName).toBe('local');
    expect(p1.model).toBe('qwen2.5:7b');

    const p2 = resolveProvider({ LLM_PROVIDER: 'ollama', LOCAL_MODEL: 'qwen2.5:14b' });
    expect(p2.providerName).toBe('local');
  });

  it('throws the openrouter error when openrouter is selected without a key', () => {
    expect(() => resolveProvider({ LLM_PROVIDER: 'openrouter' })).toThrowError(
      /OPENROUTER_API_KEY is required/,
    );
  });
});

describe('No cloud fallback in local mode (LOC-03 / INV-LOCAL)', () => {
  const cloudKeys = { OPENROUTER_API_KEY: 'or-key', GOOGLE_AI_API_KEY: 'g-key' };

  it('stays local when both cloud keys are configured', () => {
    const p = resolveProvider({ LLM_PROVIDER: 'local', ...cloudKeys });
    expect(p.providerName).toBe('local');
    expect(p).toBeInstanceOf(LocalProvider);
  });

  it('reports the runtime as unavailable rather than falling back when it does not answer', async () => {
    const p = resolveProvider({
      LLM_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:39998',
      ...cloudKeys,
    });

    await expect(async () => {
      for await (const _ of p.stream({ systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] })) { /* drain */ }
    }).rejects.toThrow(/is unavailable/);
    expect(p.providerName).toBe('local');
  });

  it.each(['lmstudio', 'llamacpp', 'llama.cpp', 'vllm', 'lemonade', 'openai-compatible'])(
    'maps the runtime name %s to the local provider instead of the cloud branch',
    name => {
      const p = resolveProvider({ LLM_PROVIDER: name, ...cloudKeys });
      expect(p.providerName).toBe('local');
    },
  );

  it('derives the runtime from the provider name when LOCAL_LLM_RUNTIME is absent', () => {
    const p = resolveProvider({ LLM_PROVIDER: 'lmstudio', ...cloudKeys }) as LocalProvider;
    expect(p.runtime).toBe('lmstudio');
  });

  it('refuses an unrecognised provider name instead of guessing a cloud provider', () => {
    expect(() => resolveProvider({ LLM_PROVIDER: 'ollamaa', ...cloudKeys })).toThrowError(
      /not a recognised provider/,
    );
  });

  it('never auto-detects local: it must be explicit', () => {
    const p = resolveProvider({ ...cloudKeys });
    expect(p.providerName).toBe('gemini');
  });

  it('passes the endpoint policy and context configuration through to the provider', () => {
    const p = resolveProvider({
      LLM_PROVIDER: 'local',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1234',
      LOCAL_LLM_MODEL: 'qwen2.5-7b-instruct',
      LOCAL_LLM_RUNTIME: 'lmstudio',
      LOCAL_LLM_CONTEXT_TOKENS: '4096',
      INFERENCE_ALLOW_LAN: 'true',
      INFERENCE_ENDPOINT_HOSTS: 'inference.lan',
    }) as LocalProvider;

    expect(p.baseUrl).toBe('http://127.0.0.1:1234');
    expect(p.model).toBe('qwen2.5-7b-instruct');
    expect(p.runtime).toBe('lmstudio');
    expect(p.configuredContextTokens).toBe(4096);
  });
});
