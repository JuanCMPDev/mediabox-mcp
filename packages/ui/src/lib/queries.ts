import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/* ── Polling intervals ───────────────────────────────────────────────────────
 * Downloads: 2s — progress bars must feel live
 * Sessions:  3s — pause/play state changes should feel immediate
 * Health:    5s — CPU/RAM variance readable at this pace
 * Services: 15s — rarely changes; 7 pings per poll, keep costs low
 * Library:  60s — very stable; new content added infrequently
 * ──────────────────────────────────────────────────────────────────────── */

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn:  api.health,
    refetchInterval: 5_000,
    retry: 2,
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn:  api.sessions,
    refetchInterval: 3_000,
    retry: 2,
  });
}

export function useDownloads() {
  return useQuery({
    queryKey: ['downloads'],
    queryFn:  api.downloads,
    refetchInterval: 2_000,
    retry: 2,
  });
}

export function useLibrary() {
  return useQuery({
    queryKey: ['library'],
    queryFn:  api.library,
    refetchInterval: 60_000,
    retry: 2,
  });
}

export function useServices() {
  return useQuery({
    queryKey: ['services'],
    queryFn:  api.services,
    refetchInterval: 15_000,
    retry: 1,
  });
}
