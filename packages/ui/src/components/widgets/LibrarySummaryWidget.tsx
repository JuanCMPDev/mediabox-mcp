import { Film, Tv2, Radio, Music, Library, WifiOff } from 'lucide-react';
import styles from './LibrarySummaryWidget.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import { Skeleton }  from '@/components/atoms/Skeleton';
import type { LibraryStats } from '@mediabox/contracts';

const STATS = [
  { key: 'movies'   as const, label: 'Movies',   Icon: Film,  color: '#adc6ff', bg: 'rgba(173,198,255,0.12)' },
  { key: 'shows'    as const, label: 'Shows',    Icon: Tv2,   color: '#b9c8de', bg: 'rgba(185,200,222,0.12)' },
  { key: 'episodes' as const, label: 'Episodes', Icon: Radio, color: '#c0c1ff', bg: 'rgba(192,193,255,0.12)' },
  { key: 'music'    as const, label: 'Tracks',   Icon: Music, color: '#4caf77', bg: 'rgba(76,175,120,0.10)'  },
];

interface LibrarySummaryWidgetProps {
  stats:     LibraryStats | null;
  isLoading: boolean;
  error:     Error | null;
}

export function LibrarySummaryWidget({ stats, isLoading, error }: LibrarySummaryWidgetProps) {
  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}><Library size={14} />Library</div>

      {isLoading && !stats && (
        <div className={styles.grid}>
          {[0,1,2,3].map(i => <Skeleton key={i} variant="block" height={72} />)}
        </div>
      )}

      {error && !stats && (
        <div className={styles.errorState}>
          <WifiOff size={22} color="var(--error)" />
          <span>Cannot reach Jellyfin</span>
        </div>
      )}

      {stats && (
        <>
          <div className={styles.grid}>
            {STATS.map(({ key, label, Icon, color, bg }) => (
              <div key={key} className={styles.statCard}>
                <div className={styles.statIcon} style={{ background: bg }}>
                  <Icon size={14} color={color} />
                </div>
                <div className={styles.statValue}>{stats[key].toLocaleString()}</div>
                <div className={styles.statLabel}>{label}</div>
              </div>
            ))}
          </div>
          <div className={styles.totalRow}>
            <span className={styles.totalLabel}>Total Library Size</span>
            <span className={styles.totalValue}>{stats.totalSize}</span>
          </div>
        </>
      )}
    </GlassCard>
  );
}
