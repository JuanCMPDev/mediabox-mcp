/* ─── @mediabox/ui — UI-only types ──────────────────────────────────────────
 * Shared API types (ServerHealth, Download, etc.) live in @mediabox/contracts.
 * Re-exported here for convenience so widget imports don't need to change.
 * ──────────────────────────────────────────────────────────────────────── */

export type {
  HealthStatus,
  HealthMetric,
  ServerHealth,
  MediaType,
  PlaybackSession,
  DownloadStatus,
  DownloadSource,
  Download,
  LibraryStats,
  ServiceStatus,
  ServiceId,
  ServiceEndpoint,
} from '@mediabox/contracts';

// ── UI-only types ─────────────────────────────────────────────────────────

export type View = 'dashboard' | 'library' | 'chat' | 'settings';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id:           string;
  role:         MessageRole;
  content:      string;
  timestamp:    Date;
  isStreaming?: boolean;
}
