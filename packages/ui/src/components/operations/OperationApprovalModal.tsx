import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Ban, CheckCircle2, Circle, Clock, Loader2, Play, Shield, X, XCircle,
} from 'lucide-react';
import type { OperationPlanRecord, OperationStepRecord } from '@mediabox/contracts';
import { GlassButton } from '@/components/atoms/GlassButton';
import {
  formatBytes,
  formatCountdown,
  isInFlight,
  isPendingApproval,
  isTerminalOperationStatus,
  operationStatusTone,
  planResourceTotals,
  secondsUntil,
} from '@/lib/operations';
import styles from './OperationApprovalModal.module.css';

export interface OperationApprovalModalProps {
  planRecord: OperationPlanRecord;
  onApprove: (planId: string, manifestHash: string) => Promise<void>;
  onReject:  (planId: string, reason: string) => Promise<void>;
  onCancel:  (planId: string) => Promise<void>;
  onClose:   () => void;
}

/** Owner-facing review of one operation plan (Blueprint §4.2). Shows the
 *  hash-covered manifest — targets, effects, resource totals — and the
 *  approval countdown; once approved it keeps rendering step progress from
 *  the (polled) record until the plan reaches a terminal status. Errors from
 *  the callbacks surface inline. Reject and cancel close the modal on
 *  success; approve keeps it open so the owner can watch. */
export function OperationApprovalModal({
  planRecord,
  onApprove,
  onReject,
  onCancel,
  onClose,
}: OperationApprovalModalProps) {
  const { t, i18n } = useTranslation('common');
  const { plan, status, statusReason, steps, currentStep, totalSteps } = planRecord;

  const [secondsRemaining, setSecondsRemaining] = useState(() => secondsUntil(plan.expiresAt));
  const [isSubmitting, setIsSubmitting]         = useState(false);
  const [error, setError]                       = useState<string | null>(null);
  const [rejectReason, setRejectReason]         = useState('');

  const pending    = isPendingApproval(status);
  const isExpired  = pending && secondsRemaining <= 0;
  const canApprove = pending && !isExpired;
  const inFlight   = isInFlight(status);
  const terminal   = isTerminalOperationStatus(status);
  const tone       = isExpired ? 'neutral' : operationStatusTone(status);

  // The countdown only matters while the owner can still act.
  useEffect(() => {
    if (!pending) return;
    const tick = () => setSecondsRemaining(secondsUntil(plan.expiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [plan.expiresAt, pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isSubmitting]);

  const totals    = useMemo(() => planResourceTotals(plan), [plan]);
  const hasTotals =
    totals.selectedBytes !== undefined
    || totals.reclaimableBytes !== undefined
    || totals.estimatedDiskBytes !== undefined;

  const stepList = steps ?? [];
  const total    = totalSteps ?? stepList.length;
  const current  = currentStep ?? stepList.filter(s => s.status === 'completed').length;
  const progress = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  async function run(action: () => Promise<void>, fallbackKey: string): Promise<boolean> {
    setIsSubmitting(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t(fallbackKey));
      return false;
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleApprove = () =>
    run(() => onApprove(plan.id, plan.manifestHash), 'operations.errors.approve');

  const handleReject = async () => {
    const reason = rejectReason.trim() || t('operations.rejectReasonDefault');
    if (await run(() => onReject(plan.id, reason), 'operations.errors.reject')) onClose();
  };

  const handleCancel = async () => {
    if (await run(() => onCancel(plan.id), 'operations.errors.cancel')) onClose();
  };

  const titleId = `operation-approval-title-${plan.id}`;
  const fmt = (bytes: number) => formatBytes(bytes, i18n.language);

  return (
    <div className={styles.backdrop} onClick={() => { if (!isSubmitting) onClose(); }}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={e => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <Shield size={22} className={styles.headerIcon} />
            <div className={styles.headerText}>
              <h2 id={titleId} className={styles.title}>{t('operations.title')}</h2>
              <div className={styles.operation}>{plan.operation}</div>
            </div>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('operations.close')}
            title={t('operations.close')}
          >
            <X size={18} />
          </button>
        </header>

        <div className={styles.statusBar}>
          <div className={styles.statusLeft}>
            <span className={styles.statusKey}>{t('operations.statusLabel')}</span>
            <span className={[styles.pill, styles[`tone_${tone}`]].join(' ')}>
              {inFlight && <Loader2 size={11} className={styles.spin} />}
              {t(`operations.status.${status}`)}
            </span>
          </div>
          {canApprove && (
            <div
              className={[styles.countdown, secondsRemaining <= 60 && styles.countdownUrgent]
                .filter(Boolean)
                .join(' ')}
            >
              <Clock size={14} />
              {t('operations.expiresIn', { time: formatCountdown(secondsRemaining) })}
            </div>
          )}
          {isExpired && (
            <div className={[styles.countdown, styles.countdownExpired].join(' ')}>
              <Clock size={14} />
              {t('operations.expired')}
            </div>
          )}
        </div>

        {statusReason && (
          <div className={styles.reason}>
            <span className={styles.reasonKey}>{t('operations.statusReason')}</span>
            <span>{statusReason}</span>
          </div>
        )}

        <div className={styles.hash}>
          <span className={styles.hashKey}>{t('operations.canonicalHash')}</span>
          <code className={styles.hashValue}>{plan.manifestHash}</code>
        </div>

        {totals.irreversibleEffects > 0 && (
          <div className={styles.warning} role="alert">
            <AlertTriangle size={16} />
            <span>{t('operations.irreversibleWarning', { count: totals.irreversibleEffects })}</span>
          </div>
        )}

        {hasTotals && (
          <dl className={styles.totals}>
            {totals.selectedBytes !== undefined && (
              <div className={styles.stat}>
                <dt>{t('operations.selectedBytes')}</dt>
                <dd>{fmt(totals.selectedBytes)}</dd>
              </div>
            )}
            {totals.reclaimableBytes !== undefined && (
              <div className={styles.stat}>
                <dt>{t('operations.reclaimableBytes')}</dt>
                <dd>{fmt(totals.reclaimableBytes)}</dd>
              </div>
            )}
            {totals.estimatedDiskBytes !== undefined && (
              <div className={styles.stat}>
                <dt>{t('operations.stagingBytes')}</dt>
                <dd>{fmt(totals.estimatedDiskBytes)}</dd>
              </div>
            )}
          </dl>
        )}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('operations.targets', { n: plan.targets.length })}</h3>
          <ul className={styles.list}>
            {plan.targets.map((target, idx) => (
              <li key={idx} className={styles.item}>
                <div className={styles.itemMain}>
                  <strong>{target.service}</strong>
                  <code className={styles.path}>{target.relativePath}</code>
                </div>
                <div className={styles.itemMeta}>
                  {t('operations.root')}: {target.rootId}
                  {target.fileIdentity?.sizeBytes !== undefined && ` · ${fmt(target.fileIdentity.sizeBytes)}`}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('operations.effects', { n: plan.effects.length })}</h3>
          <ul className={styles.list}>
            {plan.effects.map((effect, idx) => {
              const r = effect.requiredResources;
              const resourceLine = r
                ? [
                    r.selectedBytes !== undefined && `${t('operations.selectedBytes')}: ${fmt(r.selectedBytes)}`,
                    r.reclaimableBytes !== undefined && `${t('operations.reclaimableBytes')}: ${fmt(r.reclaimableBytes)}`,
                    r.estimatedDiskBytes !== undefined && `${t('operations.stagingBytes')}: ${fmt(r.estimatedDiskBytes)}`,
                  ].filter(Boolean).join(' · ')
                : '';
              return (
                <li
                  key={idx}
                  className={[styles.item, effect.irreversibleLoss && styles.itemIrreversible]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className={styles.itemMain}>
                    <strong>{t('operations.action')}: {effect.serviceAction}</strong>
                    {effect.irreversibleLoss && (
                      <span className={styles.irreversible}>
                        <AlertTriangle size={12} />
                        {t('operations.irreversibleLoss')}
                      </span>
                    )}
                  </div>
                  {effect.destination && (
                    <div className={styles.itemMeta}>
                      {t('operations.destination')}: <code className={styles.path}>{effect.destination}</code>
                    </div>
                  )}
                  {resourceLine && <div className={styles.itemMeta}>{resourceLine}</div>}
                </li>
              );
            })}
          </ul>
        </section>

        {stepList.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t('operations.progress', { current, total })}</h3>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              {/* Width is data, not styling — the only inline style in this component. */}
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            <ul className={styles.list}>
              {stepList.map(step => <StepRow key={step.stepNumber} step={step} />)}
            </ul>
          </section>
        )}

        {error && <div className={styles.error} role="alert">{error}</div>}

        <footer className={styles.footer}>
          {canApprove && (
            <>
              <input
                type="text"
                className={styles.reasonInput}
                placeholder={t('operations.rejectReasonPlaceholder')}
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                disabled={isSubmitting}
              />
              <GlassButton variant="secondary" size="sm" onClick={() => void handleReject()} disabled={isSubmitting}>
                <Ban size={14} />
                {t('operations.reject')}
              </GlassButton>
              <GlassButton variant="primary" size="sm" onClick={() => void handleApprove()} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 size={14} className={styles.spin} /> : <Play size={14} />}
                {t('operations.approve')}
              </GlassButton>
            </>
          )}
          {inFlight && (
            <GlassButton
              variant="secondary"
              size="sm"
              className={styles.danger}
              onClick={() => void handleCancel()}
              disabled={isSubmitting || status === 'cancel_requested'}
            >
              <Ban size={14} />
              {status === 'cancel_requested' ? t('operations.cancelling') : t('operations.cancel')}
            </GlassButton>
          )}
          {(terminal || isExpired) && (
            <GlassButton variant="secondary" size="sm" onClick={onClose}>
              {t('operations.close')}
            </GlassButton>
          )}
        </footer>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: OperationStepRecord }) {
  const { t } = useTranslation('common');
  const icon =
    step.status === 'completed' ? <CheckCircle2 size={14} /> :
    step.status === 'failed'    ? <XCircle size={14} /> :
    step.status === 'running'   ? <Loader2 size={14} className={styles.spin} /> :
                                  <Circle size={14} />;
  return (
    <li className={[styles.item, styles[`step_${step.status}`]].join(' ')}>
      <div className={styles.itemMain}>
        <span className={styles.stepIcon}>{icon}</span>
        <span className={styles.stepLabel}>
          {t('operations.step', { n: step.stepNumber })}: {step.action}
        </span>
        <span className={styles.stepStatus}>{t(`operations.stepStatus.${step.status}`)}</span>
      </div>
      {step.error && (
        <div className={styles.stepError}>{t('operations.stepError')}: {step.error}</div>
      )}
    </li>
  );
}
