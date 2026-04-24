/* ─── Mediabox UI domain types ────────────────────────────────────────────
 * Shaped to mirror MCP tool responses so 2.2 can swap mocks → real fetch
 * without touching component props.
 * ─────────────────────────────────────────────────────────────────────── */

export type View = 'dashboard' | 'library' | 'chat' | 'settings';

/* ── Downloads (qBittorrent: download_status) ────────────────────── */
export type DownloadStatus = 'downloading' | 'paused' | 'seeding' | 'completed' | 'error';

export interface Download {
  id: string;
  name: string;
  progress: number;      // 0–100
  size: string;          // formatted, e.g. "58.2 GB"
  speed: string;         // download speed, e.g. "12.4 MB/s" or "—"
  uploadSpeed?: string;  // upload speed for seeding torrents, e.g. "2.1 MB/s"
  eta: string;           // e.g. "43m" or "—"
  status: DownloadStatus;
  category?: string;
}

/* ── Server health (Jellyfin: server_status) ──────────────────────── */
export type HealthStatus = 'ok' | 'warning' | 'critical';

export interface HealthMetric {
  label: string;
  value: number;      // 0–100
  unit: string;
  status: HealthStatus;
}

export interface ServerHealth {
  cpu: HealthMetric;
  ram: HealthMetric;
  disk: HealthMetric;
  uptime: string;
  serverName: string;
  version: string;
  online: boolean;
}

/* ── Now playing (Jellyfin: server_status → Sessions) ────────────── */
export type MediaType = 'movie' | 'episode' | 'music';

export interface PlaybackSession {
  id: string;
  userName: string;
  mediaTitle: string;
  mediaSubtitle: string;
  mediaType: MediaType;
  coverGradient: string; // CSS gradient — replaced by real poster URL in 2.2
  progress: number;      // 0–100
  currentTime: string;
  totalTime: string;
  isPlaying: boolean;
}

/* ── Library summary (Jellyfin: get_library_state) ───────────────── */
export interface LibraryStats {
  movies: number;
  shows: number;
  episodes: number;
  music: number;
  totalSize: string;
}

/* ── External services (launched via the ServiceDock) ─────────────
 * Each entry points to a web UI exposed by a container in the stack.
 * Ports mirror packages/core/src/generators/docker-compose.ts.
 * ─────────────────────────────────────────────────────────────── */
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
  id: ServiceId;
  name: string;
  description: string;   // short line — e.g. "Media server"
  url: string;           // full http://host:port
  status: ServiceStatus;
  version?: string;
}

/* ── Chat (MCP Console — 2.3) ────────────────────────────────────── */
export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
}
