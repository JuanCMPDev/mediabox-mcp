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
export type AIProvider     = 'none' | 'openrouter' | 'google';

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
    provider: AIProvider;
    apiKey:   string;
    model:    string;             // optional for google, required for openrouter
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
