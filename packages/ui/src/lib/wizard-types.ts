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

export const DRAFT_VERSION = 1;
export const DRAFT_STORAGE_KEY = 'mediabox:wizard-draft-v1';

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
        username: draft.services.pyloadUsername,
        password: draft.services.pyloadPassword,
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

  if (draft.telegram.enabled) {
    const ids = draft.telegram.allowedUserIds
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));

    if (draft.ai.provider === 'openrouter') {
      config.telegram = {
        botToken: draft.telegram.botToken,
        allowedUserIds: ids,
        llm: { kind: 'openrouter', apiKey: draft.ai.apiKey, model: draft.ai.model || 'anthropic/claude-3.5-sonnet' },
      };
    } else if (draft.ai.provider === 'google') {
      config.telegram = {
        botToken: draft.telegram.botToken,
        allowedUserIds: ids,
        llm: { kind: 'google', apiKey: draft.ai.apiKey, ...(draft.ai.model && { model: draft.ai.model }) },
      };
    }
  }

  return config;
}

function cryptoRandomKey(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => (b % 36).toString(36)).join('');
}
