import { useState } from 'react';
import { Download, ArrowUp, Pause, Play, Trash2, Check, X, WifiOff } from 'lucide-react';
import styles from './DownloadQueueWidget.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import { Skeleton }  from '@/components/atoms/Skeleton';
import { usePauseDownload, useResumeDownload, useDeleteDownload } from '@/lib/mutations';
import { useToast } from '@/lib/toast';
import type { Download as DownloadItem, DownloadStatus } from '@mediabox/contracts';

const STATUS_LABEL: Record<DownloadStatus, string> = {
  downloading: 'Downloading',
  seeding:     'Seeding',
  paused:      'Paused',
  completed:   'Completed',
  error:       'Error',
};

function renderMeta(item: DownloadItem): React.ReactNode {
  switch (item.status) {
    case 'downloading': return `${item.speed} · ETA ${item.eta}`;
    case 'seeding':
      return <><ArrowUp size={11} style={{ display:'inline', verticalAlign:'-1px' }} />{' '}Up {item.uploadSpeed ?? '—'}</>;
    case 'paused':    return 'Paused';
    case 'completed': return 'Completed';
    case 'error':     return 'Error';
  }
}

// Extract qBit hash from unified id ("qbit:abc123" → "abc123")
function qbitHash(id: string): string | null {
  return id.startsWith('qbit:') ? id.slice(5) : null;
}

interface DownloadQueueWidgetProps {
  downloads: DownloadItem[];
  isLoading: boolean;
  error:     Error | null;
}

export function DownloadQueueWidget({ downloads, isLoading, error }: DownloadQueueWidgetProps) {
  const active = downloads.filter(d => d.status === 'downloading').length;

  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}>
        <div className={styles.headerLeft}><Download size={14} />Download Queue</div>
        {active > 0 && <span className={styles.countBadge}>{active} active</span>}
      </div>

      {isLoading && downloads.length === 0 && (
        <div className={styles.list} style={{ gap: 8 }}>
          {[0,1,2].map(i => <Skeleton key={i} variant="block" height={58} />)}
        </div>
      )}

      {error && downloads.length === 0 && (
        <div className={styles.errorState}>
          <WifiOff size={22} color="var(--error)" />
          <span>Cannot reach download client</span>
        </div>
      )}

      {downloads.length > 0 && (
        <div className={styles.list}>
          {downloads.map(item => (
            <DownloadItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </GlassCard>
  );
}

function DownloadItem({ item }: { item: DownloadItem }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { toast } = useToast();

  const pauseDownload  = usePauseDownload();
  const resumeDownload = useResumeDownload();
  const deleteDownload = useDeleteDownload();

  const hash = qbitHash(item.id);
  const isQbit = !!hash;
  const canPause  = isQbit && item.status === 'downloading';
  const canResume = isQbit && item.status === 'paused';
  const canDelete = isQbit;
  const hasActions = canPause || canResume || canDelete;

  function handlePause() {
    if (!hash) return;
    pauseDownload.mutate(hash, {
      onSuccess: () => toast('Torrent paused', 'success'),
      onError:   (e) => toast(`Pause failed: ${e.message}`, 'error'),
    });
  }

  function handleResume() {
    if (!hash) return;
    resumeDownload.mutate(hash, {
      onSuccess: () => toast('Torrent resumed', 'success'),
      onError:   (e) => toast(`Resume failed: ${e.message}`, 'error'),
    });
  }

  function handleDelete(deleteFiles: boolean) {
    if (!hash) return;
    deleteDownload.mutate({ hash, deleteFiles }, {
      onSuccess: () => { toast('Torrent deleted', 'success'); setConfirmDelete(false); },
      onError:   (e) => { toast(`Delete failed: ${e.message}`, 'error'); setConfirmDelete(false); },
    });
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemTop}>
        <span className={styles.itemName} title={item.name}>{item.name}</span>
        <div className={styles.itemRight}>
          <span className={`${styles.statusBadge} ${styles[item.status]}`}>
            {STATUS_LABEL[item.status]}
          </span>
          {hasActions && !confirmDelete && (
            <div className={styles.actions}>
              {canPause  && (
                <button className={styles.actionBtn} title="Pause" onClick={handlePause}
                  disabled={pauseDownload.isPending}>
                  <Pause size={12} />
                </button>
              )}
              {canResume && (
                <button className={styles.actionBtn} title="Resume" onClick={handleResume}
                  disabled={resumeDownload.isPending}>
                  <Play size={12} />
                </button>
              )}
              {canDelete && (
                <button className={`${styles.actionBtn} ${styles.actionDanger}`}
                  title="Delete" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}
          {confirmDelete && (
            <div className={styles.confirmRow}>
              <span className={styles.confirmLabel}>Delete files?</span>
              <button className={`${styles.actionBtn} ${styles.actionDanger}`}
                title="Delete with files" onClick={() => handleDelete(true)}
                disabled={deleteDownload.isPending}>
                <Trash2 size={12} />+
              </button>
              <button className={styles.actionBtn} title="Remove from queue only"
                onClick={() => handleDelete(false)} disabled={deleteDownload.isPending}>
                <Check size={12} />
              </button>
              <button className={styles.actionBtn} title="Cancel" onClick={() => setConfirmDelete(false)}>
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={styles.progressTrack}>
        <div className={`${styles.progressFill} ${styles[item.status]}`} style={{ width: `${item.progress}%` }} />
      </div>

      <div className={styles.itemMeta}>
        <span className={styles.size}>{item.size}</span>
        <span className={styles.metaRight}>{renderMeta(item)}</span>
      </div>
    </div>
  );
}
