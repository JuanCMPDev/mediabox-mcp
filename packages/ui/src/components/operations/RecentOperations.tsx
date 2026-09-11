import { useTranslation } from 'react-i18next';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useRecentOperations } from '@/lib/queries';
import { isPendingApproval, operationStatusTone, shortPlanId } from '@/lib/operations';
import { useOperationsGate } from './OperationsGate';
import styles from './RecentOperations.module.css';

/** Compact list of the latest operation plans across every status. Rows
 *  open the approval modal through the OperationsGate context — the same
 *  surface the top-bar badge uses — so a finished or expired plan can still
 *  be inspected after the fact. */
export function RecentOperations() {
  const { t, i18n } = useTranslation('common');
  const { data, isLoading, error } = useRecentOperations(20);
  const { open } = useOperationsGate();

  if (isLoading) {
    return (
      <div className={styles.empty}>
        <Loader2 size={14} className={styles.spin} />
        {t('status.loading')}
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.error}>
        {t('operations.recent.loadFailed', {
          message: error instanceof Error ? error.message : String(error),
        })}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return <div className={styles.empty}>{t('operations.recent.empty')}</div>;
  }

  return (
    <div className={styles.list}>
      <div className={styles.head}>
        <span>{t('operations.recent.plan')}</span>
        <span>{t('operations.recent.operation')}</span>
        <span>{t('operations.recent.status')}</span>
        <span>{t('operations.recent.createdAt')}</span>
        <span />
      </div>
      {data.map(plan => (
        <button
          key={plan.id}
          type="button"
          className={styles.row}
          onClick={() => open(plan.id)}
          title={plan.id}
        >
          <code className={styles.id}>{shortPlanId(plan.id)}</code>
          <span className={styles.op}>{plan.operation}</span>
          <span className={[styles.pill, styles[`tone_${operationStatusTone(plan.status)}`]].join(' ')}>
            {t(`operations.status.${plan.status}`)}
          </span>
          <span className={styles.date}>{formatDate(plan.createdAt, i18n.language)}</span>
          <span className={styles.action}>
            {isPendingApproval(plan.status) && (
              <span className={styles.review}>{t('operations.recent.review')}</span>
            )}
            <ChevronRight size={14} />
          </span>
        </button>
      ))}
    </div>
  );
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}
