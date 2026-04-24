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
