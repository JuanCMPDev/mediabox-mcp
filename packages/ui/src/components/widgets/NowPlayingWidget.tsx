import { Tv2, MessageSquareWarning, XCircle, Info } from 'lucide-react';
import styles from './NowPlayingWidget.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import { IconButton } from '@/components/atoms/IconButton';
import type { PlaybackSession } from '@/lib/types';

interface NowPlayingWidgetProps {
  session: PlaybackSession | null;
}

export function NowPlayingWidget({ session }: NowPlayingWidgetProps) {
  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <Tv2 size={14} />
          Jellyfin Active Stream
        </div>
      </div>

      {session ? (
        <div className={styles.body}>
          <div className={styles.cover}>
            <div
              className={styles.coverPlaceholder}
              style={{ background: session.coverGradient }}
            >
              <Tv2 size={32} color="rgba(255,255,255,0.3)" />
            </div>
          </div>

          <div className={styles.info}>
            <div className={styles.nowTag}>
              <div className={styles.pulseDot} />
              {session.isPlaying ? 'Playing' : 'Paused'}
            </div>
            <div className={styles.title}>{session.mediaTitle}</div>
            <div className={styles.subtitle}>{session.mediaSubtitle}</div>
            
            <div className={styles.user}>
               Watching as <span style={{color: 'var(--on-surface)'}}>{session.userName}</span>
            </div>

            <div className={styles.progressSection}>
              <div className={styles.progressTimes}>
                <span>{session.currentTime}</span>
                <span>{session.totalTime}</span>
              </div>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${session.progress}%` }}
                />
              </div>
            </div>

            <div className={styles.controls}>
              <IconButton title="Session Details">
                <Info size={16} />
              </IconButton>
              <IconButton title="Send Message to User">
                <MessageSquareWarning size={16} />
              </IconButton>
              <IconButton title="Kill Stream">
                <XCircle size={16} color="var(--error)" />
              </IconButton>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.empty}>
          <Tv2 size={36} />
          <p>No active streams</p>
        </div>
      )}
    </GlassCard>
  );
}
