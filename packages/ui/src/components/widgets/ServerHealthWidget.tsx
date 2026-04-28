import { Server, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './ServerHealthWidget.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import { Skeleton } from '@/components/atoms/Skeleton';
import type { ServerHealth, HealthStatus } from '@mediabox/contracts';

const RADIUS = 28;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function RingMetric({ value, unit, label, status }: { value: number; unit: string; label: string; status: HealthStatus }) {
  const filled = ((value / 100) * CIRCUMFERENCE).toFixed(2);
  const gap    = (CIRCUMFERENCE - parseFloat(filled)).toFixed(2);
  return (
    <div className={styles.metric}>
      <div className={styles.ring}>
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle className={styles.ringTrack} cx="36" cy="36" r={RADIUS} strokeWidth="5" />
          <circle
            className={`${styles.ringFill} ${styles[status]}`}
            cx="36" cy="36" r={RADIUS} strokeWidth="5"
            strokeDasharray={`${filled} ${gap}`}
          />
        </svg>
        <div className={styles.ringValue}>
          {value}<span style={{ fontSize: 10, opacity: 0.7 }}>{unit}</span>
        </div>
      </div>
      <span className={styles.metricLabel}>{label}</span>
    </div>
  );
}

interface ServerHealthWidgetProps {
  health:    ServerHealth | null;
  isLoading: boolean;
  error:     Error | null;
}

export function ServerHealthWidget({ health, isLoading, error }: ServerHealthWidgetProps) {
  const { t } = useTranslation();
  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}>
        <div className={styles.headerTitle}><Server size={14} />{t('dashboard.health.title')}</div>
        {health && (
          <div className={[styles.statusBadge, !health.online && styles.offline].filter(Boolean).join(' ')}>
            <div className={styles.dot} />
            {health.online ? t('dashboard.health.online') : t('dashboard.health.offline')}
          </div>
        )}
      </div>

      {isLoading && !health && (
        <div className={styles.metricsRow}>
          {[0,1,2].map(i => <Skeleton key={i} variant="circle" width={72} height={72} />)}
        </div>
      )}

      {error && !health && (
        <div className={styles.errorState}>
          <WifiOff size={24} color="var(--error)" />
          <span>{t('dashboard.health.cannotReach')}</span>
        </div>
      )}

      {health && (
        <>
          <div className={styles.metricsRow}>
            <RingMetric {...health.cpu}  label={t('dashboard.health.cpu')}  />
            <RingMetric {...health.ram}  label={t('dashboard.health.ram')}  />
            <RingMetric {...health.disk} label={t('dashboard.health.disk')} />
          </div>
          <div className={styles.serverInfo}>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>{t('dashboard.health.uptime')}</span>
              <span className={styles.infoVal}>{health.uptime}</span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>{t('dashboard.health.version')}</span>
              <span className={styles.infoVal}>{health.version}</span>
            </div>
          </div>
        </>
      )}
    </GlassCard>
  );
}
