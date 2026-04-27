/* ─── @mediabox/contracts ────────────────────────────────────────────────────
 * Single source of truth for every type that crosses the wire between
 * @mediabox/mcp-server (REST responses) and @mediabox/ui (fetch hooks).
 *
 * Rules:
 *  - No runtime values — only `type` and `interface` exports.
 *  - Keep 1-to-1 with REST response shapes in api/dashboard.ts.
 *  - UI-only types (View, ChatMessage, etc.) live in @mediabox/ui.
 * ──────────────────────────────────────────────────────────────────────── */

// ── Server Health ────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'warning' | 'critical';

export interface HealthMetric {
  label:  string;
  value:  number;    // 0–100
  unit:   string;
  status: HealthStatus;
}

export interface ServerHealth {
  cpu:        HealthMetric;
  ram:        HealthMetric;
  disk:       HealthMetric;
  uptime:     string;          // "14d 6h 42m"
  serverName: string;
  version:    string;
  online:     boolean;
}

// ── Playback sessions ────────────────────────────────────────────────────────

export type MediaType = 'movie' | 'episode' | 'music';

export interface PlaybackSession {
  id:               string;
  userName:         string;
  userId?:          string;
  deviceName?:      string;
  mediaTitle:       string;
  mediaSubtitle:    string;   // e.g. "S02E07 — Chikhai Bardo"
  mediaType:        MediaType;
  coverUrl?:        string;   // Jellyfin image URL (public, no auth needed)
  coverGradient?:   string;   // CSS gradient — fallback when no coverUrl (mock)
  progress:         number;   // 0–100
  currentTime:      string;   // "22:14"
  totalTime:        string;   // "49:33"
  isPlaying:        boolean;
  jellyfinSessionId?: string; // needed for admin actions (Phase 2.2.5)
}

// ── Downloads ────────────────────────────────────────────────────────────────

export type DownloadStatus = 'downloading' | 'paused' | 'seeding' | 'completed' | 'error';
export type DownloadSource = 'qbittorrent' | 'pyload';

export interface Download {
  id:           string;           // "qbit:{hash}" | "pyload:{pid}"
  name:         string;
  progress:     number;           // 0–100
  size:         string;           // formatted: "58.2 GB"
  speed:        string;           // "12.4 MB/s" or "—"
  uploadSpeed?: string;           // seeding upload speed
  eta:          string;           // "43m" or "—"
  status:       DownloadStatus;
  category?:    string;
  source:       DownloadSource;
}

// ── Library ──────────────────────────────────────────────────────────────────

export interface LibraryStats {
  movies:    number;
  shows:     number;
  episodes:  number;
  music:     number;
  totalSize: string;   // "42.7 TB"
}

// ── External services ────────────────────────────────────────────────────────

export type ServiceStatus = 'online' | 'warning' | 'offline';

export type ServiceId =
  | 'jellyfin'
  | 'sonarr'
  | 'radarr'
  | 'prowlarr'
  | 'qbittorrent'
  | 'pyload'
  | 'flaresolverr'
  | 'bazarr';

export interface ServiceEndpoint {
  id:           ServiceId;
  name:         string;
  description:  string;
  url:          string;   // browser-accessible: http://localhost:PORT
  status:       ServiceStatus;
  version?:     string;
}

// ── Live container log streaming (Phase 3.3) ────────────────────────────────
// Wire format for GET /api/setup/logs/:service (mcp-server → UI).
// Events are emitted as NDJSON: one JSON object per line.

export type LogEvent =
  | { type: 'log';    line: string; ts: string }
  | { type: 'closed'; reason: 'eof' | 'killed' | 'error'; message?: string };

// ── Docker image update streaming (Phase 3.3) ────────────────────────────────
// Wire format for POST /api/setup/check-updates (mcp-server → UI).
// Streams `docker compose pull --progress plain` output as NDJSON.

export type PullEvent =
  | { type: 'log';  line: string }
  | { type: 'done'; ok: boolean; message?: string };

// ── Chat streaming (Phase 2.3) ───────────────────────────────────────────────
// Wire format between POST /api/chat/stream (mcp-server) and the browser UI.
// Events are emitted as NDJSON: one JSON object per line.

export type ChatEvent =
  | { type: 'conversation'; id: string }
  | { type: 'token';        text: string }
  | { type: 'tool-start';   name: string; args: Record<string, unknown> }
  | { type: 'tool-end';     name: string; ok: boolean; durationMs: number }
  | { type: 'done';         fullText: string }
  | { type: 'error';        message: string };

/** Returned by GET /api/chat/info — tells the UI which provider/model is active. */
export interface ChatInfo {
  provider: string;
  model:    string;
}

/** Simplified entry returned by GET /api/chat/:id/history — display-only. */
export interface ChatHistoryEntry {
  role:    'user' | 'assistant';
  content: string;
}

// ── Setup wizard request payload (Phase 3.2) ─────────────────────────────────
// Shape of the body POSTed to /api/setup/start. Mirrors @mediabox/core's
// DeployConfig — kept here because the UI can't depend on @mediabox/core
// without pulling in execa/yaml/etc. into the SPA bundle.

export interface DeployConfig {
  deployment: DeploymentConfig;
  system:     SystemConfig;
  paths:      MediaPathsConfig;
  services:   ServicesConfig;
  mcp:        McpConfig;
  telegram?:  TelegramConfig;
}

export interface DeploymentConfig {
  mode:              'local' | 'vps' | 'tunnel';
  baseDomain?:       string;
  letsEncryptEmail?: string;
  tunnelToken?:      string;
  localBuild:        boolean;
  imageTag:          string;
}

export interface SystemConfig {
  timezone: string;
  puid:     number;
  pgid:     number;
}

export interface MediaPathsConfig {
  movies: string;
  tv:     string;
  anime:  string;
  music:  string;
}

export interface ServicesConfig {
  jellyfin: {
    adminUsername: string;
    adminPassword: string;
  };
  qbittorrent: {
    password: string;
  };
  pyload: {
    username: string;
    password: string;
  };
  bazarr: {
    enabled: boolean;
  };
}

export interface McpConfig {
  publicUrl:      string;
  internalApiKey: string;
}

export type LLMProviderConfig =
  | { kind: 'openrouter'; apiKey: string; model: string }
  | { kind: 'google';     apiKey: string; model?: string };

export interface TelegramConfig {
  botToken:        string;
  llm:             LLMProviderConfig;
  allowedUserIds:  number[];
}

// ── Setup wizard streaming (Phase 3.2) ───────────────────────────────────────
// Wire format between POST /api/setup/start (mcp-server) and the desktop wizard.
// One JSON-serialized DeployEvent per NDJSON line. The phases mirror what the
// CLI sink already renders, so the same event taxonomy works for spinners
// (CLI) and progress bars (desktop UI).

export type DeployPhase =
  | 'config:validate'
  | 'generate:compose'
  | 'generate:env'
  | 'generate:qbittorrent'
  | 'generate:caddy'
  | 'generate:directories'
  | 'deploy:prepare-images'
  | 'deploy:start'
  | 'deploy:health'
  | 'discover:api-keys'
  | 'configure:jellyfin'
  | 'configure:sonarr'
  | 'configure:radarr'
  | 'configure:prowlarr'
  | 'configure:qbittorrent'
  | 'configure:flaresolverr'
  | 'configure:arr-auth'
  | 'configure:jellyfin-libraries'
  | 'write:env-update'
  | 'deploy:restart';

export type DeployEvent =
  | { kind: 'start';    phase: DeployPhase; message: string }
  | { kind: 'progress'; phase: DeployPhase; message: string; percent?: number }
  | { kind: 'success';  phase: DeployPhase; message: string }
  | { kind: 'warn';     phase: DeployPhase; message: string }
  | { kind: 'error';    phase: DeployPhase; message: string; cause?: unknown }
  | { kind: 'log';      level: 'info' | 'debug'; message: string };

/** Surfaces the wizard's overall state to the UI without a separate poll. */
export type SetupStatus =
  | { type: 'starting' }
  | { type: 'event'; event: DeployEvent }
  | { type: 'finished'; ok: boolean; warnings: string[]; durationMs: number }
  | { type: 'error';    message: string };

// ── Settings administration (PR 3.2 — Tier A) ────────────────────────────────
// `GET /api/setup/info` returns this — sanitised view of the deployed stack
// for the Settings panel. Booleans like `hasPassword` let the UI render a
// "•••• configured" placeholder without ever shipping the secret to the webview.

export interface SetupInfo {
  stack: {
    workDir:        string | null;
    deploymentMode: string;
    imageTag:       string;
    baseDomain:     string | null;
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
    jellyfin:     ServiceCreds;
    qbittorrent:  ServiceCreds;
    pyload:       ServiceCreds;
    sonarr:       ServiceCreds;
    radarr:       ServiceCreds;
    prowlarr:     ServiceCreds;
    flaresolverr: { url: string };
    bazarr:       ServiceCreds & { enabled: boolean };
  };
  ai: {
    provider: 'none' | 'openrouter' | 'google';
    model:    string | null;
    hasKey:   boolean;
  };
  telegram: {
    enabled:        boolean;
    hasToken:       boolean;
    allowedUserIds: number[];
  };
  app: {
    version: string;
  };
}

export interface ServiceCreds {
  url:           string;
  user?:         string;       // jellyfin admin user / qBit user / pyload user
  hasPassword?:  boolean;
  hasApiKey?:    boolean;      // sonarr / radarr / prowlarr / jellyfin
}

/** Body for `PATCH /api/setup/env` — partial map of env-key → new value. */
export interface EnvUpdate {
  [envKey: string]: string;
}

/** Response from `PATCH /api/setup/env`. */
export interface EnvUpdateResult {
  /** Keys that were actually written to disk (filtered against allowlist). */
  updated: string[];
  /** Containers (or "sidecar") whose state needs a restart to take effect. */
  restartRequired: string[];
  /** Validation issues (per-key) — non-empty means the patch was rejected. */
  errors: Array<{ key: string; message: string }>;
}

/** Body for `POST /api/setup/restart-services`. */
export interface RestartServicesRequest {
  /** Service names from docker-compose.yml. Use ["all"] to restart everything. */
  services: string[];
}

export interface RestartServicesResult {
  restarted: string[];
  errors:    Array<{ service: string; message: string }>;
}
