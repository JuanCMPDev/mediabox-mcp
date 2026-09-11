import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useRefreshIntervals } from './use-app-preferences';
import {
  ACTIVE_OPERATION_STATUSES,
  ALL_OPERATION_STATUSES,
  isTerminalOperationStatus,
} from './operations';

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

/* ── Operation plans (owner approval flow, Blueprint §4) ─────────────────────
 * These poll on fixed cadences rather than the refresh profile: a plan that
 * waits for approval expires on a short TTL, so the owner must see it fast.
 * Every key starts with 'operations' so one invalidateQueries({ queryKey:
 * ['operations'] }) after approve/reject/cancel refreshes all of them.
 * ──────────────────────────────────────────────────────────────────────── */

/** Plans that still need the owner's attention — pending approval or in flight. */
export function useActiveOperations() {
  return useQuery({
    queryKey: ['operations', 'active'],
    queryFn:  async () => (await api.operationsList(ACTIVE_OPERATION_STATUSES, 20)).plans,
    refetchInterval: 3000,
    retry: 1,
  });
}

/** One plan record, polled every 2s until it reaches a terminal status
 *  (then polling stops). Disabled while `id` is null. */
export function useOperation(id: string | null) {
  return useQuery({
    queryKey: ['operations', 'plan', id],
    queryFn:  () => api.operationGet(id as string),
    enabled:  id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isTerminalOperationStatus(status) ? false : 2000;
    },
    retry: 1,
  });
}

/** Recent plans across every status — the Settings → Operations list. */
export function useRecentOperations(limit = 20) {
  return useQuery({
    queryKey: ['operations', 'recent', limit],
    queryFn:  async () => (await api.operationsList(ALL_OPERATION_STATUSES, limit)).plans,
    refetchInterval: 10_000,
    retry: 1,
  });
}
