import { useState } from 'react';
import { Download, ArrowUp, Pause, Play, Trash2, Check, X, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './DownloadQueueWidget.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';
import { Skeleton }  from '@/components/atoms/Skeleton';
import { usePauseDownload, useResumeDownload, useDeleteDownload } from '@/lib/mutations';
import { useToast } from '@/lib/toast';
import type { Download as DownloadItem } from '@mediabox/contracts';

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
  const { t } = useTranslation();
  const active = downloads.filter(d => d.status === 'downloading').length;

  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}>
        <div className={styles.headerLeft}><Download size={14} />{t('dashboard.downloads.title')}</div>
        {active > 0 && <span className={styles.countBadge}>{t('dashboard.downloads.active', { count: active })}</span>}
      </div>

      {isLoading && downloads.length === 0 && (
        <div className={styles.list} style={{ gap: 8 }}>
          {[0,1,2].map(i => <Skeleton key={i} variant="block" height={58} />)}
        </div>
      )}

      {error && downloads.length === 0 && (
        <div className={styles.errorState}>
          <WifiOff size={22} color="var(--error)" />
          <span>{t('dashboard.downloads.cannotReach')}</span>
        </div>
      )}

      {downloads.length > 0 && (
        <div className={styles.list}>
          {downloads.map(item => (
            <DownloadItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </GlassCard>
  );
}

function renderMeta(item: DownloadItem, t: (key: string, opts?: Record<string, unknown>) => string): React.ReactNode {
  switch (item.status) {
    case 'downloading': return t('dashboard.downloads.etaPattern', { speed: item.speed, eta: item.eta });
    case 'seeding':
      return <><ArrowUp size={11} style={{ display:'inline', verticalAlign:'-1px' }} />{' '}{t('dashboard.downloads.uploading', { speed: item.uploadSpeed ?? '—' })}</>;
    case 'paused':    return t('dashboard.downloads.status.paused');
    case 'completed': return t('dashboard.downloads.status.completed');
    case 'error':     return t('dashboard.downloads.status.error');
  }
}

function DownloadItemRow({ item }: { item: DownloadItem }) {
  const { t } = useTranslation();
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
      onSuccess: () => toast(t('dashboard.downloads.torrentPaused'), 'success'),
      onError:   (e) => toast(t('dashboard.downloads.pauseFailed', { message: e.message }), 'error'),
    });
  }

  function handleResume() {
    if (!hash) return;
    resumeDownload.mutate(hash, {
      onSuccess: () => toast(t('dashboard.downloads.torrentResumed'), 'success'),
      onError:   (e) => toast(t('dashboard.downloads.resumeFailed', { message: e.message }), 'error'),
    });
  }

  function handleDelete(deleteFiles: boolean) {
    if (!hash) return;
    deleteDownload.mutate({ hash, deleteFiles }, {
      onSuccess: () => { toast(t('dashboard.downloads.torrentDeleted'), 'success'); setConfirmDelete(false); },
      onError:   (e) => { toast(t('dashboard.downloads.deleteFailed', { message: e.message }), 'error'); setConfirmDelete(false); },
    });
  }

  return (
    <div className={styles.item}>
      <div className={styles.itemTop}>
        <span className={styles.itemName} title={item.name}>{item.name}</span>
        <div className={styles.itemRight}>
          <span className={`${styles.statusBadge} ${styles[item.status]}`}>
            {t(`dashboard.downloads.status.${item.status}`)}
          </span>
          {hasActions && !confirmDelete && (
            <div className={styles.actions}>
              {canPause  && (
                <button className={styles.actionBtn} title={t('dashboard.downloads.actions.pause')} onClick={handlePause}
                  disabled={pauseDownload.isPending}>
                  <Pause size={12} />
                </button>
              )}
              {canResume && (
                <button className={styles.actionBtn} title={t('dashboard.downloads.actions.resume')} onClick={handleResume}
                  disabled={resumeDownload.isPending}>
                  <Play size={12} />
                </button>
              )}
              {canDelete && (
                <button className={`${styles.actionBtn} ${styles.actionDanger}`}
                  title={t('dashboard.downloads.actions.delete')} onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          )}
          {confirmDelete && (
            <div className={styles.confirmRow}>
              <span className={styles.confirmLabel}>{t('dashboard.downloads.deleteFiles')}</span>
              <button className={`${styles.actionBtn} ${styles.actionDanger}`}
                title={t('dashboard.downloads.actions.deleteWithFiles')} onClick={() => handleDelete(true)}
                disabled={deleteDownload.isPending}>
                <Trash2 size={12} />+
              </button>
              <button className={styles.actionBtn} title={t('dashboard.downloads.actions.removeFromQueue')}
                onClick={() => handleDelete(false)} disabled={deleteDownload.isPending}>
                <Check size={12} />
              </button>
              <button className={styles.actionBtn} title={t('dashboard.downloads.actions.cancel')} onClick={() => setConfirmDelete(false)}>
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
        <span className={styles.metaRight}>{renderMeta(item, t)}</span>
      </div>
    </div>
  );
}
