import type { DeployConfig } from '@mediabox/contracts';

/* ─── Wizard internal model ────────────────────────────────────────────────────
 * The wizard builds up state field-by-field across 8 steps. We keep our own
 * shape (rather than a Partial<DeployConfig>) because:
 *   • Some fields are split across steps (e.g. password vs username).
 *   • The UI tracks a few extras (provider="none", workdir).
 *   • Drafts persist to localStorage as JSON, so we want flat primitives.
 *
 * `draftToDeployConfig()` produces the wire payload from a complete draft.
 * ──────────────────────────────────────────────────────────────────────── */

export type DeploymentMode = 'local' | 'vps' | 'tunnel';
export type AIProvider     = 'none' | 'openrouter' | 'google' | 'local';

export interface WizardDraft {
  step: number;          // 0-7
  workDir: string;       // absolute path where the stack lives

  deployment: {
    mode:             DeploymentMode;
    baseDomain:       string;     // required for vps + tunnel
    letsEncryptEmail: string;     // required for vps
    tunnelToken:      string;     // required for tunnel
    localBuild:       boolean;
    imageTag:         string;     // GHCR tag, e.g. "latest"
  };

  system: {
    timezone: string;
    puid:     number;
    pgid:     number;
  };

  paths: {
    movies: string;
    tv:     string;
    anime:  string;
    music:  string;
  };

  services: {
    jellyfinAdminUsername: string;
    jellyfinAdminPassword: string;
    qbitPassword:          string;
    pyloadUsername:        string;
    pyloadPassword:        string;
    bazarrEnabled:         boolean;
  };

  ai: {
    provider:       AIProvider;
    apiKey:         string;
    model:          string;             // optional for google, required for openrouter
    runtime?:       string;
    baseUrl?:       string;
    contextTokens?: number;
  };

  telegram: {
    enabled:         boolean;
    botToken:        string;
    allowedUserIds:  string;       // comma-separated; parsed on submit
  };
}

// PR 3.4d: bump from v1 → v2 because the wizard step indices shifted (added
// LanguageStep at position 0). Stale v1 drafts would land users on the
// wrong screen — useWizardDraft keys off this storage key so v1 drafts are
// silently dropped and the user starts fresh on the language step.
export const DRAFT_VERSION = 2;
export const DRAFT_STORAGE_KEY = 'mediabox:wizard-draft-v2';

export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function emptyDraft(): WizardDraft {
  return {
    step: 0,
    workDir: '',
    deployment: {
      mode: 'local',
      baseDomain: '',
      letsEncryptEmail: '',
      tunnelToken: '',
      localBuild: false,
      imageTag: 'latest',
    },
    system: {
      timezone: detectTimezone(),
      puid: 1000,
      pgid: 1000,
    },
    paths: {
      movies: './media/movies',
      tv:     './media/tv',
      anime:  './media/anime',
      music:  './media/music',
    },
    services: {
      jellyfinAdminUsername: 'mediabox',
      jellyfinAdminPassword: '',
      qbitPassword: '',
      pyloadUsername: 'pyload',
      pyloadPassword: '',
      bazarrEnabled: false,
    },
    ai: {
      provider: 'none',
      apiKey: '',
      model: '',
    },
    telegram: {
      enabled: false,
      botToken: '',
      allowedUserIds: '',
    },
  };
}

/** Translate a fully-filled draft into the wire payload accepted by /api/setup/start. */
export function draftToDeployConfig(draft: WizardDraft): DeployConfig {
  const config: DeployConfig = {
    deployment: {
      mode: draft.deployment.mode,
      localBuild: draft.deployment.localBuild,
      imageTag: draft.deployment.imageTag,
      ...(draft.deployment.mode === 'vps' && {
        baseDomain: draft.deployment.baseDomain,
        letsEncryptEmail: draft.deployment.letsEncryptEmail,
      }),
      ...(draft.deployment.mode === 'tunnel' && {
        baseDomain: draft.deployment.baseDomain,
        tunnelToken: draft.deployment.tunnelToken,
      }),
    },
    system: {
      timezone: draft.system.timezone,
      puid: draft.system.puid,
      pgid: draft.system.pgid,
    },
    paths: {
      movies: draft.paths.movies,
      tv:     draft.paths.tv,
      anime:  draft.paths.anime,
      music:  draft.paths.music,
    },
    services: {
      jellyfin: {
        adminUsername: draft.services.jellyfinAdminUsername,
        adminPassword: draft.services.jellyfinAdminPassword,
      },
      qbittorrent: { password: draft.services.qbitPassword },
      pyload: {
        // PyLoad-ng's image hardcodes the credentials to pyload:pyload and
        // exposes no API to change them at deploy time, so the wizard no
        // longer collects pyload input. We send the defaults verbatim — the
        // env generator hardcodes the same values regardless.
        username: 'pyload',
        password: 'pyload',
      },
      bazarr: { enabled: draft.services.bazarrEnabled },
    },
    mcp: {
      // The desktop sidecar already serves the MCP server; the embedded
      // mcp-server in docker-compose is for external callers (Claude Desktop,
      // Telegram bot). Fill with sensible defaults the wizard doesn't ask for.
      publicUrl: 'http://localhost:3000',
      internalApiKey: cryptoRandomKey(48),
    },
  };

  // AI provider lives at the top level of DeployConfig now (was nested under
  // telegram). env.ts always writes LLM_PROVIDER / OPENROUTER_API_KEY etc.
  // when this is set, so the in-app AI assistant works even if the user
  // skipped Telegram in the wizard.
  if (draft.ai.provider === 'openrouter') {
    config.ai = {
      kind:   'openrouter',
      apiKey: draft.ai.apiKey,
      model:  draft.ai.model || 'openai/gpt-4o',
    };
  } else if (draft.ai.provider === 'google') {
    config.ai = {
      kind:   'google',
      apiKey: draft.ai.apiKey,
      ...(draft.ai.model && { model: draft.ai.model }),
    };
  } else if (draft.ai.provider === 'local') {
    // The same values the AI step shows, so the endpoint follows the runtime.
    const local = effectiveLocalAi(draft.ai);
    config.ai = {
      kind:          'local',
      runtime:       local.runtime as any,
      baseUrl:       local.baseUrl,
      model:         local.model,
      contextTokens: local.contextTokens,
      apiKey:        draft.ai.apiKey || undefined,
    };
  }

  if (draft.telegram.enabled && config.ai) {
    const ids = draft.telegram.allowedUserIds
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));

    config.telegram = {
      botToken:       draft.telegram.botToken,
      allowedUserIds: ids,
      // Mirror the same LLM into telegram.llm for the bot. env.ts no longer
      // writes the LLM vars from this — it reads `config.ai` — so this is
      // just for the contracts shape today, but kept so the legacy fallback
      // path in env.ts works for older callers.
      llm: config.ai,
    };
  }

  return config;
}

function cryptoRandomKey(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => (b % 36).toString(36)).join('');
}

/* ─── Local AI defaults ──────────────────────────────────────────────────────
 * One source for what the AI step shows and what the deploy config writes, so
 * an untouched field never deploys a different value than the one on screen.
 * ──────────────────────────────────────────────────────────────────────── */

const LOCAL_ENDPOINTS: Record<string, string> = {
  ollama:   'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
  llamacpp: 'http://127.0.0.1:8080',
  vllm:     'http://127.0.0.1:8000',
};
export const LOCAL_DEFAULT_MODEL = 'qwen2.5:7b';
export const LOCAL_DEFAULT_CONTEXT_TOKENS = 8192;

/** Runtime, endpoint, model and context the local provider will really use. */
export function effectiveLocalAi(ai: WizardDraft['ai']): { runtime: string; baseUrl: string; model: string; contextTokens: number } {
  const runtime = ai.runtime || 'ollama';
  return {
    runtime,
    baseUrl:       ai.baseUrl?.trim() || LOCAL_ENDPOINTS[runtime] || LOCAL_ENDPOINTS.ollama,
    model:         ai.model.trim() || LOCAL_DEFAULT_MODEL,
    contextTokens: ai.contextTokens || LOCAL_DEFAULT_CONTEXT_TOKENS,
  };
}

/**
 * Whether the AI provider is complete: what the AI step needs to continue and
 * what the Telegram bot needs to mirror it. Local mode has no API key; it only
 * needs an http(s) endpoint and a model, and both have defaults.
 */
export function isAiConfigured(ai: WizardDraft['ai']): boolean {
  switch (ai.provider) {
    case 'none':
      return false;
    case 'local': {
      const { baseUrl, model } = effectiveLocalAi(ai);
      return isHttpUrl(baseUrl) && model.length > 0;
    }
    case 'openrouter':
      return ai.apiKey.trim().length > 0 && ai.model.trim().length > 0;
    case 'google':
      return ai.apiKey.trim().length > 0;
    default:
      return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
