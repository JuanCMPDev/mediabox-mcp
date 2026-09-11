import { OpenRouterProvider } from './openrouter.js';
import { GeminiProvider }     from './gemini.js';
import { LocalProvider }      from './local.js';
import type { StreamProvider } from './types.js';
import type { LocalRuntimeKind } from '@mediabox/contracts';
import { parseHostList } from './endpoint-policy.js';

export interface ProviderEnv {
  OPENROUTER_API_KEY?: string;
  GOOGLE_AI_API_KEY?:  string;
  LLM_MODEL?:          string;
  LLM_PROVIDER?:       string;
  /** Canonical local inference variables (§3.6). */
  LOCAL_LLM_BASE_URL?:       string;
  LOCAL_LLM_MODEL?:          string;
  LOCAL_LLM_RUNTIME?:        string;
  LOCAL_LLM_API_KEY?:        string;
  LOCAL_LLM_CONTEXT_TOKENS?: string;
  INFERENCE_ALLOW_LAN?:      string;
  INFERENCE_ENDPOINT_HOSTS?: string;
  /** Short aliases accepted for backwards compatibility. */
  LOCAL_BASE_URL?:    string;
  LOCAL_MODEL?:       string;
  LOCAL_RUNTIME?:     string;
  LOCAL_ALLOW_LAN?:   string;
}

const DEFAULT_MODELS: Record<string, string> = {
  openrouter: 'openai/gpt-4o-mini',
  gemini:     'gemini-2.0-flash',
  local:      'qwen2.5:7b',
};

// Canonicalize provider names. The wizard/generators write LLM_PROVIDER=google
// (matching config.ai.kind === 'google'), but the runtime provider is 'gemini'.
// Without this alias, LLM_PROVIDER=google fell through to the OpenRouter branch
// and threw — crash-looping the Telegram bot and disabling in-app chat.
//
// Every local runtime name is aliased too: `LLM_PROVIDER=lmstudio` used to fall
// through to the cloud branch and silently send local-mode traffic to OpenRouter,
// which is an INV-LOCAL violation (LOC-03).
const PROVIDER_ALIASES: Record<string, string> = {
  google:              'gemini',
  gemini:              'gemini',
  openrouter:          'openrouter',
  local:               'local',
  ollama:              'local',
  lmstudio:            'local',
  'lm-studio':         'local',
  llamacpp:            'local',
  'llama.cpp':         'local',
  'llama-cpp':         'local',
  vllm:                'local',
  lemonade:            'local',
  'openai-compatible': 'local',
};

/** Provider names that select local inference, and the runtime each implies. */
const LOCAL_RUNTIME_FROM_NAME: Record<string, LocalRuntimeKind> = {
  ollama:              'ollama',
  lmstudio:            'lmstudio',
  'lm-studio':         'lmstudio',
  llamacpp:            'llamacpp',
  'llama.cpp':         'llamacpp',
  'llama-cpp':         'llamacpp',
  vllm:                'vllm',
  lemonade:            'lemonade',
  'openai-compatible': 'openai-compatible',
};

const VALID_PROVIDER_NAMES = Object.keys(PROVIDER_ALIASES);

function normalizeProviderName(raw: string | undefined): { canonical: string; raw: string } | undefined {
  if (!raw) return undefined;
  const key = raw.toLowerCase().trim();
  if (key.length === 0) return undefined;
  const canonical = PROVIDER_ALIASES[key];
  if (!canonical) {
    // Never guess: an unrecognised name must not resolve to a cloud provider.
    throw new Error(
      `LLM_PROVIDER='${raw}' is not a recognised provider. Valid values: ${VALID_PROVIDER_NAMES.join(', ')}.`,
    );
  }
  return { canonical, raw: key };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export function resolveProvider(env: ProviderEnv): StreamProvider {
  const openrouterKey = env.OPENROUTER_API_KEY ?? '';
  const googleKey     = env.GOOGLE_AI_API_KEY  ?? '';

  // Explicit override (aliased) → auto-detect fallback. Auto-detection never
  // selects local: local inference is always explicit (§3.1 / INV-LOCAL).
  const explicit = normalizeProviderName(env.LLM_PROVIDER);
  const providerName = explicit?.canonical ?? (googleKey ? 'gemini' : 'openrouter');

  if (providerName === 'local') {
    const runtime =
      (firstNonEmpty(env.LOCAL_LLM_RUNTIME, env.LOCAL_RUNTIME) as LocalRuntimeKind | undefined) ??
      (explicit ? LOCAL_RUNTIME_FROM_NAME[explicit.raw] : undefined) ??
      'ollama';

    const contextRaw = Number(firstNonEmpty(env.LOCAL_LLM_CONTEXT_TOKENS) ?? '');
    const model =
      firstNonEmpty(env.LLM_MODEL, env.LOCAL_LLM_MODEL, env.LOCAL_MODEL) ?? DEFAULT_MODELS.local;

    return new LocalProvider({
      baseUrl: firstNonEmpty(env.LOCAL_LLM_BASE_URL, env.LOCAL_BASE_URL),
      model,
      runtime,
      apiKey: firstNonEmpty(env.LOCAL_LLM_API_KEY),
      contextTokens: Number.isFinite(contextRaw) && contextRaw > 0 ? contextRaw : undefined,
      allowLan: env.INFERENCE_ALLOW_LAN === 'true' || env.LOCAL_ALLOW_LAN === '1',
      endpointHosts: parseHostList(env.INFERENCE_ENDPOINT_HOSTS),
    });
  }

  const model = firstNonEmpty(env.LLM_MODEL) ?? DEFAULT_MODELS[providerName] ?? DEFAULT_MODELS.openrouter;

  if (providerName === 'gemini') {
    if (!googleKey) throw new Error('GOOGLE_AI_API_KEY is required for provider=gemini');
    return new GeminiProvider(googleKey, model);
  }

  // Default: openrouter
  if (!openrouterKey) throw new Error('OPENROUTER_API_KEY is required for provider=openrouter');
  return new OpenRouterProvider(openrouterKey, model);
}
