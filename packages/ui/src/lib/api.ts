import type {
  ServerHealth,
  PlaybackSession,
  Download,
  LibraryStats,
  ServiceEndpoint,
  ChatInfo,
  ChatHistoryEntry,
  SetupInfo,
  EnvUpdate,
  EnvUpdateResult,
  RestartServicesResult,
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

async function post<T = void>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const { apiUrl } = getRuntimeConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: HEADERS(),
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function patch<T = void>(path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const { apiUrl } = getRuntimeConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'PATCH',
    headers: HEADERS(),
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function getText(path: string): Promise<string> {
  const { apiUrl } = getRuntimeConfig();
  const res = await fetch(`${apiUrl}${path}`, {
    headers: HEADERS(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.text();
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

  // ── Setup admin (Settings panel) ───────────────────────────────────────────
  setupInfo(): Promise<SetupInfo> {
    return get('/api/setup/info');
  },
  setupEnvRaw(): Promise<string> {
    return getText('/api/setup/env-raw');
  },
  setupPatchEnv(updates: EnvUpdate): Promise<EnvUpdateResult> {
    return patch<EnvUpdateResult>('/api/setup/env', updates);
  },
  setupRestartServices(services: string[]): Promise<RestartServicesResult> {
    return post<RestartServicesResult>('/api/setup/restart-services', { services }, 5 * 60_000);
  },
  setupStackRestart() { return post('/api/setup/stack/restart', undefined, 5 * 60_000); },
  setupStackStop()    { return post('/api/setup/stack/stop',    undefined, 60_000); },
  setupStackStart()   { return post('/api/setup/stack/start',   undefined, 2 * 60_000); },
};
