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
  ChatChoiceItem,
} from '@mediabox/contracts';

// ── UI-only types ─────────────────────────────────────────────────────────

export type View = 'dashboard' | 'library' | 'chat' | 'settings';

export type MessageRole = 'user' | 'assistant' | 'system';

export type ToolStatus = 'running' | 'ok' | 'error';

/** Per-turn record of an MCP tool the assistant called. Rendered as a chip
 *  under the assistant bubble so the user can see what happened — no expansion
 *  in v1 (args/result aren't piped through; that's a Phase 3 polish). */
export interface ToolCallRecord {
  callId:      string;
  name:        string;
  status:      ToolStatus;
  startedAt:   number;
  durationMs?: number;
  error?:      string;
}

export interface ChatMessage {
  id:           string;
  role:         MessageRole;
  content:      string;
  timestamp:    Date;
  isStreaming?: boolean;
  /** Tools the assistant invoked while producing this message. */
  tools?:       ToolCallRecord[];
  /** Clickable cards the assistant emitted via present_choices. */
  choices?: {
    prompt?: string;
    items:   import('@mediabox/contracts').ChatChoiceItem[];
  };
}
