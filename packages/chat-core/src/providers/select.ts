import { OpenRouterProvider } from './openrouter.js';
import { GeminiProvider }     from './gemini.js';
import type { StreamProvider } from './types.js';

interface ProviderEnv {
  OPENROUTER_API_KEY?: string;
  GOOGLE_AI_API_KEY?:  string;
  LLM_MODEL?:         string;
  LLM_PROVIDER?:      string;
}

const DEFAULT_MODELS: Record<string, string> = {
  openrouter: 'openai/gpt-4o-mini',
  gemini:     'gemini-2.0-flash',
};

export function resolveProvider(env: ProviderEnv): StreamProvider {
  const openrouterKey = env.OPENROUTER_API_KEY ?? '';
  const googleKey     = env.GOOGLE_AI_API_KEY  ?? '';

  // Explicit override → auto-detect fallback
  const providerName = env.LLM_PROVIDER
    ?? (googleKey ? 'gemini' : 'openrouter');

  const model = env.LLM_MODEL ?? DEFAULT_MODELS[providerName] ?? DEFAULT_MODELS.openrouter;

  if (providerName === 'gemini') {
    if (!googleKey) throw new Error('GOOGLE_AI_API_KEY is required for provider=gemini');
    return new GeminiProvider(googleKey, model);
  }

  // Default: openrouter
  if (!openrouterKey) throw new Error('OPENROUTER_API_KEY is required for provider=openrouter');
  return new OpenRouterProvider(openrouterKey, model);
}
