/* ─── Operation plans — status vocabulary & presentation helpers ─────────────
 * Shared by the approval modal, the top-bar badge (OperationsGate) and the
 * Settings → Operations list. The status sets mirror the executor's state
 * machine (Blueprint §4 / P03): a plan waits for the owner, then runs, then
 * lands in exactly one terminal state.
 * ──────────────────────────────────────────────────────────────────────── */
import type { OperationPlan, OperationStatus } from '@mediabox/contracts';

/** Waiting for the owner — the approval modal auto-opens for these. */
export const PENDING_APPROVAL_STATUSES: readonly OperationStatus[] = ['planned', 'awaiting_approval'];
/** Approved and being executed — cancellable, progress worth watching. */
export const IN_FLIGHT_STATUSES: readonly OperationStatus[] = ['queued', 'running', 'verifying', 'cancel_requested'];
/** Everything the badge counts. */
export const ACTIVE_OPERATION_STATUSES: readonly OperationStatus[] = [
  ...PENDING_APPROVAL_STATUSES,
  ...IN_FLIGHT_STATUSES,
];
/** Nothing more will happen to the plan — polling can stop. */
export const TERMINAL_OPERATION_STATUSES: readonly OperationStatus[] = [
  'succeeded', 'rejected', 'expired', 'stale', 'cancelled', 'failed', 'partial', 'unknown_outcome', 'interrupted',
];
export const ALL_OPERATION_STATUSES: readonly OperationStatus[] = [
  ...ACTIVE_OPERATION_STATUSES,
  ...TERMINAL_OPERATION_STATUSES,
];

export function isPendingApproval(status: OperationStatus): boolean {
  return PENDING_APPROVAL_STATUSES.includes(status);
}

export function isInFlight(status: OperationStatus): boolean {
  return IN_FLIGHT_STATUSES.includes(status);
}

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return TERMINAL_OPERATION_STATUSES.includes(status);
}

/** Colour family for a status pill — the CSS modules define `tone_<tone>`. */
export type OperationStatusTone = 'pending' | 'active' | 'success' | 'error' | 'neutral';

export function operationStatusTone(status: OperationStatus): OperationStatusTone {
  switch (status) {
    case 'planned':
    case 'awaiting_approval':
      return 'pending';
    case 'queued':
    case 'running':
    case 'verifying':
    case 'cancel_requested':
      return 'active';
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'partial':
    case 'unknown_outcome':
    case 'interrupted':
      return 'error';
    default: // rejected, expired, stale, cancelled — the owner said no, or time did
      return 'neutral';
  }
}

export interface PlanResourceTotals {
  /** Logical bytes the plan touches (sum of effect.requiredResources.selectedBytes). */
  selectedBytes?: number;
  /** Bytes actually freed once done — quarantine moves and hard links reclaim 0 (DEL-06). */
  reclaimableBytes?: number;
  /** Extra disk needed while running (staging / temp output). */
  estimatedDiskBytes?: number;
  /** How many effects destroy data irreversibly. */
  irreversibleEffects: number;
}

/** Sums the per-effect resource estimates. A field stays `undefined` when no
 *  effect reports it, so the UI can hide rows that would only read "0 B". */
export function planResourceTotals(plan: OperationPlan): PlanResourceTotals {
  const totals: PlanResourceTotals = { irreversibleEffects: 0 };
  for (const effect of plan.effects) {
    if (effect.irreversibleLoss) totals.irreversibleEffects += 1;
    const r = effect.requiredResources;
    if (!r) continue;
    if (typeof r.selectedBytes === 'number') {
      totals.selectedBytes = (totals.selectedBytes ?? 0) + r.selectedBytes;
    }
    if (typeof r.reclaimableBytes === 'number') {
      totals.reclaimableBytes = (totals.reclaimableBytes ?? 0) + r.reclaimableBytes;
    }
    if (typeof r.estimatedDiskBytes === 'number') {
      totals.estimatedDiskBytes = (totals.estimatedDiskBytes ?? 0) + r.estimatedDiskBytes;
    }
  }
  return totals;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** 1536 → "1.5 KB", 0 → "0 B". Binary (1024) steps, locale-aware separators. */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const maximumFractionDigits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toLocaleString(locale, { maximumFractionDigits })} ${BYTE_UNITS[unit]}`;
}

/** Whole seconds until an ISO timestamp, floored at 0. Invalid input → 0. */
export function secondsUntil(iso: string, now: number = Date.now()): number {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.floor((target - now) / 1000));
}

/** 754 → "12:34"; 3661 → "1:01:01". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Compact plan id for tables — the full id goes in a tooltip. */
export function shortPlanId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
