import type {
  ServerHealth,
  PlaybackSession,
  Download,
  LibraryStats,
  ServiceEndpoint,
  ChatInfo,
  ChatHistoryEntry,
} from '@mediabox/contracts';

import { getRuntimeConfig } from './runtime-config';

const HEADERS = () => {
  const { internalApiKey } = getRuntimeConfig();
  return {
    Authorization:  `Bearer ${internalApiKey}`,
    'Content-Type': 'application/json',
  };
};

async function get<T>(path: string): Promise<T> {
  const { apiUrl } = getRuntimeConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    headers: HEADERS(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json() as Promise<T>;
}

async function post(path: string, body?: unknown): Promise<void> {
  const { apiUrl } = getRuntimeConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: HEADERS(),
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

async function del(path: string): Promise<void> {
  const { apiUrl } = getRuntimeConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    method:  'DELETE',
    headers: HEADERS(),
    signal:  AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
}

export const api = {
  // ── Reads ──────────────────────────────────────────────────────────────────
  health():    Promise<ServerHealth>      { return get('/api/dashboard/health');    },
  sessions():  Promise<PlaybackSession[]> { return get('/api/dashboard/sessions');  },
  downloads(): Promise<Download[]>        { return get('/api/dashboard/downloads'); },
  library():   Promise<LibraryStats>      { return get('/api/dashboard/library');   },
  services():  Promise<ServiceEndpoint[]> { return get('/api/dashboard/services');  },

  // ── Session actions ────────────────────────────────────────────────────────
  killSession(sessionId: string) {
    return post(`/api/dashboard/sessions/${sessionId}/stop`);
  },
  messageUser(sessionId: string, payload: { header: string; text: string }) {
    return post(`/api/dashboard/sessions/${sessionId}/message`, payload);
  },

  // ── qBittorrent actions ────────────────────────────────────────────────────
  pauseDownload(hash: string) {
    return post(`/api/dashboard/downloads/qbit/${hash}/pause`);
  },
  resumeDownload(hash: string) {
    return post(`/api/dashboard/downloads/qbit/${hash}/resume`);
  },
  deleteDownload(hash: string, deleteFiles = false) {
    return del(`/api/dashboard/downloads/qbit/${hash}?deleteFiles=${deleteFiles}`);
  },

  // ── Chat ───────────────────────────────────────────────────────────────────
  chatInfo(): Promise<ChatInfo> {
    return get('/api/chat/info');
  },
  chatHistory(conversationId: string): Promise<ChatHistoryEntry[]> {
    return get(`/api/chat/${conversationId}/history`);
  },
  clearChat(conversationId: string) {
    return del(`/api/chat/${conversationId}`);
  },
};
