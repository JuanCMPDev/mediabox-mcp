import { Download, ArrowUp } from 'lucide-react';
import styles from './DownloadQueueWidget.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import type { Download as DownloadItem, DownloadStatus } from '@/lib/types';

const STATUS_LABEL: Record<DownloadStatus, string> = {
  downloading: 'Downloading',
  seeding:     'Seeding',
  paused:      'Paused',
  completed:   'Completed',
  error:       'Error',
};

interface DownloadQueueWidgetProps {
  downloads: DownloadItem[];
}

export function DownloadQueueWidget({ downloads }: DownloadQueueWidgetProps) {
  const active = downloads.filter((d) => d.status === 'downloading').length;

  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Download size={14} />
          Download Queue
        </div>
        {active > 0 && (
          <span className={styles.countBadge}>{active} active</span>
        )}
      </div>

      <div className={styles.list}>
        {downloads.map((item) => (
          <div key={item.id} className={styles.item}>
            <div className={styles.itemTop}>
              <span className={styles.itemName} title={item.name}>
                {item.name}
              </span>
              <span className={`${styles.statusBadge} ${styles[item.status]}`}>
                {STATUS_LABEL[item.status]}
              </span>
            </div>

            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${styles[item.status]}`}
                style={{ width: `${item.progress}%` }}
              />
            </div>

            <div className={styles.itemMeta}>
              <span className={styles.size}>{item.size}</span>
              <span className={styles.metaRight}>
                {renderMeta(item)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

function renderMeta(item: DownloadItem): React.ReactNode {
  switch (item.status) {
    case 'downloading':
      return `${item.speed} · ETA ${item.eta}`;
    case 'seeding':
      return (
        <>
          <ArrowUp size={11} style={{ display: 'inline', verticalAlign: '-1px' }} />
          {' '}Up {item.uploadSpeed ?? '—'}
        </>
      );
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'error':
      return 'Error';
  }
}
