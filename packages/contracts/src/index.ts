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
//
// `callId` lets the UI match a tool-end with its tool-start so per-turn tool
// history can render alongside the assistant message. Optional for back-compat
// — older engine builds may omit it.
//
// `choices` is emitted when the assistant calls the virtual `present_choices`
// tool. The UI renders the items as clickable cards; clicking one sends the
// chosen `value` back as the next user message (so the LLM picks up exactly
// what was selected — full IDs included, not just the visible label).

export interface ChatChoiceItem {
  /** Stable id for React keys; not sent back to the LLM. */
  id:         string;
  /** Headline shown on the card (e.g. "Night of the Living Dead (1968)"). */
  label:      string;
  /** Optional secondary line (e.g. "TMDB ID: 10331 · Director: George A. Romero"). */
  subtitle?:  string;
  /** Optional short context line under subtitle (e.g. "Action · 96 min"). */
  meta?:      string;
  /**
   * Verbatim text sent back as the next user turn when the card is clicked.
   * Should embed any IDs the LLM needs so the next turn isn't ambiguous.
   * Example: "Quiero la versión de 1968 (TMDB ID: 10331)".
   */
  value:      string;
  /** Optional structured typed selection (P07 / CAT-04). */
  selection?: TypedSelection;
}

export type Phase = 'orient' | 'discover' | 'select' | 'propose' | 'monitor' | 'maintain';

export type AgentErrorCode =
  | 'ERR_TOOL_NOT_EXPOSED'
  | 'ERR_ARGS_INVALID'
  | 'ERR_REPAIR_EXHAUSTED'
  | 'ERR_LOOP_DETECTED'
  | 'ERR_TURN_BUDGET'
  | 'ERR_CONTEXT_OVERFLOW'
  | 'ERR_PROVIDER_UNAVAILABLE'
  | 'ERR_PROVIDER_PROTOCOL'
  | 'ERR_TOOL_TIMEOUT'
  | 'ERR_CANCELLED'
  | 'ERR_WORKFLOW_CORRUPT'
  | 'ERR_ENDPOINT_POLICY'
  | 'ERR_TURN_IN_FLIGHT';

export type ChatEvent =
  | { type: 'conversation'; id: string }
  | { type: 'token';        text: string }
  | { type: 'tool-start';   name: string; args: Record<string, unknown>; callId?: string }
  | { type: 'tool-end';     name: string; ok: boolean; durationMs: number; callId?: string; error?: string }
  | { type: 'phase';        phase: Phase; reason: string }
  | { type: 'guard';        code: AgentErrorCode; message: string }
  | { type: 'choices';      prompt?: string; items: ChatChoiceItem[] }
  | { type: 'done';         fullText: string }
  | { type: 'error';        message: string; code?: string };

/** Returned by GET /api/chat/info — tells the UI which provider/model is active. */
export interface ChatInfo {
  provider: string;
  model:    string;
  mode:     'local' | 'cloud';
  runtime?: string;
  backend?: string;
  contextTokens?: number;
  agentCompatible?: boolean;
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
  /**
   * LLM provider for the in-app AI assistant. Optional — present only when
   * the user picks a non-`none` provider in the wizard. Independent of
   * Telegram so users who skip Telegram still get the AI assistant working.
   *
   * env.ts uses this to write `LLM_PROVIDER`, `LLM_MODEL`, and the matching
   * `OPENROUTER_API_KEY` / `GOOGLE_AI_API_KEY` to `.env` regardless of
   * whether Telegram is configured.
   */
  ai?:        LLMProviderConfig;
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
  /**
   * Dedicated agent credential (loopback chat client, Telegram bot). Distinct
   * from `internalApiKey` so the agent never carries owner authority
   * (Blueprint §4.1 / B02 / INV-SEPARATION). Generated when absent.
   */
  agentApiKey?:   string;
  /** Stable installation identity bound into sessions, plans and references. */
  installationId?: string;
}

export type LocalRuntimeKind =
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm'
  | 'lemonade'
  | 'openai-compatible';

export type InferenceBackend =
  | 'auto'
  | 'cuda'
  | 'rocm'
  | 'vulkan'
  | 'sycl'
  | 'metal'
  | 'cpu';

export type LLMProviderConfig =
  | { kind: 'openrouter'; apiKey: string; model: string }
  | { kind: 'google';     apiKey: string; model?: string }
  | {
      kind: 'local';
      runtime: LocalRuntimeKind;
      baseUrl: string;
      model: string;
      contextTokens?: number;
      backend?: InferenceBackend;
      apiKey?: string;
      allowLan?: boolean;
      endpointHosts?: string[];
      tlsFingerprint?: string;
    };

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

// ── Setup info snapshot (Phase 3.4a) ─────────────────────────────────────────
// Returned by GET /api/setup/info. Summarises current stack configuration for
// the Settings panel. Sensitive secrets are masked to boolean flags or a
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
    provider: 'none' | 'openrouter' | 'google' | 'local';
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
  /** Containers (or "sidecar") whose state needs a `restart` to take effect. */
  restartRequired: string[];
  /**
   * Containers that need to be `recreated` (`docker compose up -d
   * --force-recreate`) — Docker bakes some env vars into the container at
   * `up` time (TZ, PUID, PGID, bind-mount sources), so a simple restart is
   * a no-op for those. The special value `"all"` means every container.
   */
  recreateRequired: string[];
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

// ── Identity & Authorization (P02 / §4.1) ──────────────────────────────────

export type PrincipalKind =
  | "owner-ui"
  | "agent-session"
  | "installer"
  | "executor"
  | "external-client"
  | "owner"
  | "agent";

export interface Principal {
  id: string;
  installationId: string;
  kind: PrincipalKind;
  capabilities: string[];
  audience: string;
  sessionId: string;
  expiresAt: number;
  credentialVersion: number;
}

// ── Persistent Operation Plans, Approval & Executor (P03 / §4.2) ───────────

export type OperationStatus =
  | "planned"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "verifying"
  | "succeeded"
  | "rejected"
  | "expired"
  | "stale"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "partial"
  | "unknown_outcome"
  | "interrupted";

export interface PlannedTargetFileIdentity {
  sizeBytes?: number;
  mtimeMs?: number;
  inode?: number;
  sha256?: string;
  /** Hard-link count observed at plan time; >1 means quarantine/purge frees no space (DEL-06). */
  nlink?: number;
  kind?: "file" | "directory";
}

export interface PlannedTarget {
  service: string;
  entityId?: string;
  rootId: string;
  relativePath: string;
  namespaceMap?: Record<string, string>;
  fileIdentity?: PlannedTargetFileIdentity;
  observedState: string;
}

export interface PlannedEffectResources {
  /** Extra bytes the effect needs while running (staging, temp output). */
  estimatedDiskBytes?: number;
  estimatedTimeSec?: number;
  /** Logical bytes selected by the effect (file size). */
  selectedBytes?: number;
  /** Bytes actually reclaimable on the volume once the effect completes.
   *  Quarantine moves never reclaim space; hard-linked files reclaim 0 (§4.3 / DEL-06). */
  reclaimableBytes?: number;
}

export interface PlannedEffect {
  targetIndex?: number;
  destination?: string;
  tracksProfile?: string;
  serviceAction: string;
  irreversibleLoss: boolean;
  requiredResources?: PlannedEffectResources;
  /** Closed, hash-covered parameters for the service action (release guid, indexer id, queue ids…). */
  params?: Record<string, string | number | boolean>;
}

export interface Precondition {
  id: string;
  type: "file_exists" | "hash_matches" | "size_matches" | "service_online" | "custom";
  description: string;
  expected: unknown;
  actual?: unknown;
}

export interface RecoveryPlan {
  strategy: "restore_from_quarantine" | "delete_temporary" | "rollback_service" | "none";
  quarantinePath?: string;
  cleanupPaths?: string[];
  instructions?: string;
}

export interface OperationPlan {
  schemaVersion: 1;
  id: string;
  installationId: string;
  ownerId: string;
  conversationId: string;
  operation: string;
  manifestVersion: number;
  manifestHash: string;
  createdAt: string;
  expiresAt: string;
  policyVersion: string;
  snapshotId: string;
  targets: PlannedTarget[];
  effects: PlannedEffect[];
  preconditions: Precondition[];
  recovery: RecoveryPlan;
  proposalKey?: string;
}

export interface OperationStepRecord {
  stepNumber: number;
  action: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export interface OperationPlanRecord {
  plan: OperationPlan;
  status: OperationStatus;
  statusReason?: string;
  approvedAt?: string;
  approvedBy?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  currentStep?: number;
  totalSteps?: number;
  steps?: OperationStepRecord[];
  leaseOwner?: string;
  leaseExpiresAt?: number;
  proposalKey?: string;
}

export interface PlanApprovalRequest {
  planId: string;
  manifestHash: string;
  expectedVersion?: number;
}

export interface PlanRejectionRequest {
  planId: string;
  reason: string;
}

export interface PlanCancellationRequest {
  planId: string;
  reason?: string;
}

export interface OperationPlanSummary {
  id: string;
  operation: string;
  status: OperationStatus;
  statusReason?: string;
  createdAt: string;
  expiresAt: string;
  targetsCount: number;
  effectsCount: number;
  manifestHash: string;
  conversationId: string;
  ownerId: string;
  approvedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

// ── Normalized Queries & Tool Envelopes (P06 / §4.4) ─────────────────────────

export type DataSourceCompleteness = "complete" | "partial" | "unavailable" | "unknown";

export interface DataSourceStatus {
  source: string;
  observedAt: string;
  snapshotId?: string;
  completeness: DataSourceCompleteness;
  error?: {
    code: string;
    message: string;
  };
}

export interface EnvelopePage {
  cursor?: string;
  hasMore: boolean;
  totalItems: number | null;
  pageSize: number;
  pageIndex?: number;
}

export interface EnvelopeBudget {
  bytesUsed: number;
  bytesLimit: number;
  itemsReturned: number;
  itemsAvailable?: number;
  truncatedFields?: string[];
}

export interface ToolEnvelope<T> {
  schemaVersion: 1;
  requestId: string;
  status: "ok" | "partial" | "error";
  data: T;
  sources: DataSourceStatus[];
  page?: EnvelopePage;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  budget?: EnvelopeBudget;
}

// ── Catalog Identity & Deterministic Ranking (P07 / §4.5) ──────────────────

export interface MediaItemProviderIds {
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  sonarrId?: number;
  radarrId?: number;
  jellyfinId?: string;
}

export interface MediaItem {
  id: string;
  mediaRef: string;
  title: string;
  year?: number;
  type: "movie" | "series" | "episode" | "music";
  overview?: string;
  posterUrl?: string;
  providerIds: MediaItemProviderIds;
  inLibrary: boolean;
  libraryStatus?: {
    monitored?: boolean;
    status?: string;
    downloadedEpisodes?: number;
    totalEpisodes?: number;
  };
}

export interface ReleaseCandidate {
  releaseRef: string;
  guid: string;
  title: string;
  sizeBytes: number;
  seeders: number;
  leechers?: number;
  protocol: "torrent" | "usenet";
  indexer: string;
  indexerId?: number;
  quality: string;
  resolution?: string;
  codec?: string;
  languages: string[];
  score: number;
  reasons: string[];
  rejected: boolean;
  rejections?: string[];
}

export interface TypedSelection {
  type: "select_candidate" | "select_release" | "propose_download";
  mediaRef?: string;
  releaseRef?: string;
  action?: string;
  value?: string;
}

/** Body of POST /api/chat/stream. A typed `selection` (card click) is turned
 *  into a deterministic user turn by the server instead of free LLM text (CAT-04). */
export interface ChatStreamRequest {
  message: string;
  conversationId?: string;
  selection?: TypedSelection;
}

// ── Quarantine (P04 / §4.3) ─────────────────────────────────────────────────

export interface QuarantineEntry {
  rootId: string;
  /** Path of the quarantined file relative to the root's trash directory. */
  entryPath: string;
  originalRelativePath: string;
  planId?: string;
  quarantinedAt: string;
  expiresAt: string;
  sizeBytes: number;
  nlink: number;
  /** Bytes a purge would actually free (0 when hard-linked elsewhere). */
  reclaimableOnPurgeBytes: number;
}

