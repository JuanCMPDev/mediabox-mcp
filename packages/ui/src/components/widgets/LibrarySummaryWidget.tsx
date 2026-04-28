import { useState } from 'react';
import { Film, Tv2, Radio, Music, Library, RefreshCw, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './LibrarySummaryWidget.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import { Skeleton }  from '@/components/atoms/Skeleton';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import type { LibraryStats } from '@mediabox/contracts';

const STATS = [
  { key: 'movies'   as const, labelKey: 'movies',   Icon: Film,  color: '#adc6ff', bg: 'rgba(173,198,255,0.12)' },
  { key: 'shows'    as const, labelKey: 'shows',    Icon: Tv2,   color: '#b9c8de', bg: 'rgba(185,200,222,0.12)' },
  { key: 'episodes' as const, labelKey: 'episodes', Icon: Radio, color: '#c0c1ff', bg: 'rgba(192,193,255,0.12)' },
  { key: 'music'    as const, labelKey: 'tracks',   Icon: Music, color: '#4caf77', bg: 'rgba(76,175,120,0.10)'  },
];

interface LibrarySummaryWidgetProps {
  stats:     LibraryStats | null;
  isLoading: boolean;
  error:     Error | null;
}

export function LibrarySummaryWidget({ stats, isLoading, error }: LibrarySummaryWidgetProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await api.setupRefreshJellyfinLibrary();
      toast(t('dashboard.library.refreshTriggered'), 'success');
    } catch (err) {
      toast(
        t('dashboard.library.refreshFailed', { message: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Library size={14} />
          {t('dashboard.library.title')}
        </div>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => void handleRefresh()}
          disabled={refreshing || !!error}
          title={t('dashboard.library.refresh')}
          aria-label={t('dashboard.library.refresh')}
        >
          <RefreshCw size={13} className={refreshing ? styles.refreshSpin : undefined} />
        </button>
      </div>

      {isLoading && !stats && (
        <div className={styles.grid}>
          {[0,1,2,3].map(i => <Skeleton key={i} variant="block" height={72} />)}
        </div>
      )}

      {error && !stats && (
        <div className={styles.errorState}>
          <WifiOff size={22} color="var(--error)" />
          <span>{t('dashboard.library.cannotReach')}</span>
        </div>
      )}

      {stats && (
        <>
          <div className={styles.grid}>
            {STATS.map(({ key, labelKey, Icon, color, bg }) => (
              <div key={key} className={styles.statCard}>
                <div className={styles.statIcon} style={{ background: bg }}>
                  <Icon size={14} color={color} />
                </div>
                <div className={styles.statValue}>{stats[key].toLocaleString()}</div>
                <div className={styles.statLabel}>{t(`dashboard.library.${labelKey}`)}</div>
              </div>
            ))}
          </div>
          <div className={styles.totalRow}>
            <span className={styles.totalLabel}>{t('dashboard.library.totalSize')}</span>
            <span className={styles.totalValue}>{stats.totalSize}</span>
          </div>
        </>
      )}
    </GlassCard>
  );
}
