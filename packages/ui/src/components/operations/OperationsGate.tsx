import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { OperationPlanSummary } from '@mediabox/contracts';
import { api } from '@/lib/api';
import { useActiveOperations, useOperation } from '@/lib/queries';
import { isPendingApproval } from '@/lib/operations';
import { OperationApprovalModal } from './OperationApprovalModal';
import styles from './OperationsGate.module.css';

/* ─── OperationsGate ──────────────────────────────────────────────────────────
 * The owner's approval surface (Blueprint §4.2 / B02). Mounted once around
 * the app shell it:
 *   • polls the active plans (planned → verifying) every 3s,
 *   • auto-opens the approval modal for the OLDEST plan awaiting approval,
 *   • exposes counts + an `open()` action through context so the top-bar
 *     badge and the Settings list can reopen any plan on demand,
 *   • keeps the modal open after approval, polling the record every 2s so
 *     the owner watches step progress until a terminal status.
 * Plans the owner closed or rejected in this session are remembered in a
 * ref so the auto-open never nags about them again; an explicit click on
 * the badge or a list row still opens them.
 * ──────────────────────────────────────────────────────────────────────── */

interface OperationsGateContextValue {
  /** Plans pending approval or in flight. */
  activeCount:  number;
  /** Subset of `activeCount` still waiting for the owner. */
  pendingCount: number;
  /** Open the modal for a specific plan (explicit action — ignores the dismissed set). */
  open:           (planId: string) => void;
  /** Open the most recently created active plan, if any. */
  openMostRecent: () => void;
}

const NOOP_CONTEXT: OperationsGateContextValue = {
  activeCount: 0,
  pendingCount: 0,
  open: () => {},
  openMostRecent: () => {},
};

const OperationsGateContext = createContext<OperationsGateContextValue>(NOOP_CONTEXT);
const EMPTY: OperationPlanSummary[] = [];

export function useOperationsGate(): OperationsGateContextValue {
  return useContext(OperationsGateContext);
}

export function OperationsGate({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('common');
  const qc = useQueryClient();
  const { data: active } = useActiveOperations();
  const [openId, setOpenId] = useState<string | null>(null);
  const dismissed = useRef<Set<string>>(new Set());
  const { data: record, error: recordError } = useOperation(openId);

  const activeList  = active ?? EMPTY;
  const pendingList = useMemo(
    () => activeList.filter(p => isPendingApproval(p.status)),
    [activeList],
  );

  // (a) Auto-open the oldest plan still awaiting approval, skipping dismissed ones.
  useEffect(() => {
    if (openId !== null) return;
    const candidates = pendingList.filter(p => !dismissed.current.has(p.id));
    if (candidates.length === 0) return;
    const oldest = candidates.reduce((a, b) =>
      Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b,
    );
    setOpenId(oldest.id);
  }, [pendingList, openId]);

  // A plan that can no longer be loaded (purged, 404) is dropped and never retried.
  useEffect(() => {
    if (openId !== null && recordError && !record) {
      dismissed.current.add(openId);
      setOpenId(null);
    }
  }, [openId, recordError, record]);

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['operations'] });
  }, [qc]);

  const handleApprove = useCallback(async (planId: string, manifestHash: string) => {
    await api.operationApprove(planId, manifestHash);
    invalidate();
  }, [invalidate]);

  const handleReject = useCallback(async (planId: string, reason: string) => {
    await api.operationReject(planId, reason);
    dismissed.current.add(planId);
    invalidate();
  }, [invalidate]);

  const handleCancel = useCallback(async (planId: string) => {
    await api.operationCancel(planId, t('operations.cancelReasonDefault'));
    dismissed.current.add(planId);
    invalidate();
  }, [invalidate, t]);

  const close = useCallback(() => {
    setOpenId(current => {
      if (current !== null) dismissed.current.add(current);
      return null;
    });
  }, []);

  const contextValue = useMemo<OperationsGateContextValue>(() => ({
    activeCount:  activeList.length,
    pendingCount: pendingList.length,
    open: (planId: string) => setOpenId(planId),
    openMostRecent: () => {
      if (activeList.length === 0) return;
      const newest = activeList.reduce((a, b) =>
        Date.parse(a.createdAt) >= Date.parse(b.createdAt) ? a : b,
      );
      setOpenId(newest.id);
    },
  }), [activeList, pendingList.length]);

  return (
    <OperationsGateContext.Provider value={contextValue}>
      {children}
      {openId !== null && record && (
        <OperationApprovalModal
          key={openId}
          planRecord={record}
          onApprove={handleApprove}
          onReject={handleReject}
          onCancel={handleCancel}
          onClose={close}
        />
      )}
    </OperationsGateContext.Provider>
  );
}

/** Small top-bar pill with the active-plan count. Turns amber and pulses
 *  while any plan waits for approval; hidden entirely when nothing is active
 *  so it stays out of the way. Click → modal for the most recent active plan. */
export function OperationsBadge() {
  const { t } = useTranslation('common');
  const { activeCount, pendingCount, openMostRecent } = useOperationsGate();
  if (activeCount === 0) return null;

  const hasPending = pendingCount > 0;
  const label = hasPending
    ? t('operations.badgePending', { count: pendingCount })
    : t('operations.badgeTitle', { count: activeCount });
  const Icon = hasPending ? ShieldAlert : ShieldCheck;

  return (
    <button
      type="button"
      className={[styles.badge, hasPending && styles.badgePending].filter(Boolean).join(' ')}
      onClick={openMostRecent}
      title={label}
      aria-label={label}
    >
      <Icon size={13} />
      <span className={styles.badgeCount}>{activeCount}</span>
    </button>
  );
}
