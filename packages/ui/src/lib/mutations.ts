import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

// ── Session admin actions ─────────────────────────────────────────────────────

export function useKillSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.killSession(sessionId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useMessageUser() {
  return useMutation({
    mutationFn: ({ sessionId, header, text }: { sessionId: string; header: string; text: string }) =>
      api.messageUser(sessionId, { header, text }),
  });
}

// ── qBittorrent download actions ──────────────────────────────────────────────

export function usePauseDownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hash: string) => api.pauseDownload(hash),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });
}

export function useResumeDownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hash: string) => api.resumeDownload(hash),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });
}

export function useDeleteDownload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ hash, deleteFiles }: { hash: string; deleteFiles: boolean }) =>
      api.deleteDownload(hash, deleteFiles),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['downloads'] }),
  });
}
