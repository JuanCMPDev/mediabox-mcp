import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useRefreshIntervals } from './use-app-preferences';

/* ── Polling intervals ───────────────────────────────────────────────────────
 * Per-query refetch cadence is sourced from `useRefreshIntervals()` so the
 * user can switch profiles in Settings → Preferences without an app reload.
 * Profile defaults (see use-app-preferences.tsx):
 *   realtime — Downloads 2s, Sessions 3s, Health 5s, Services 15s, Setup 30s
 *   balanced — roughly 2× the realtime cadence
 *   battery  — roughly 6× the realtime cadence
 * ──────────────────────────────────────────────────────────────────────── */

export function useHealth() {
  const intervals = useRefreshIntervals();
  return useQuery({
    queryKey: ['health'],
    queryFn:  api.health,
    refetchInterval: intervals.health,
    retry: 2,
  });
}

export function useSessions() {
  const intervals = useRefreshIntervals();
  return useQuery({
    queryKey: ['sessions'],
    queryFn:  api.sessions,
    refetchInterval: intervals.sessions,
    retry: 2,
  });
}

export function useDownloads() {
  const intervals = useRefreshIntervals();
  return useQuery({
    queryKey: ['downloads'],
    queryFn:  api.downloads,
    refetchInterval: intervals.downloads,
    retry: 2,
  });
}

export function useLibrary() {
  const intervals = useRefreshIntervals();
  return useQuery({
    queryKey: ['library'],
    queryFn:  api.library,
    refetchInterval: intervals.library,
    retry: 2,
  });
}

export function useServices() {
  const intervals = useRefreshIntervals();
  return useQuery({
    queryKey: ['services'],
    queryFn:  api.services,
    refetchInterval: intervals.services,
    retry: 1,
  });
}

export function useSetupInfo() {
  const intervals = useRefreshIntervals();
  return useQuery({
    queryKey: ['setup-info'],
    queryFn:  api.setupInfo,
    refetchInterval: intervals.setupInfo,
    retry: 1,
  });
}
