import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Download, CheckCircle, AlertCircle, Loader, RefreshCw, Rocket } from 'lucide-react';
import { api } from '@/lib/api';
import { useToast } from '@/lib/toast';
import { useUpdateStream, type UpdateStreamStatus } from '@/lib/use-update-stream';
import styles from './UpdateDrawer.module.css';

interface Props {
  onClose:    () => void;
  onApplied?: () => void;
}

export function UpdateDrawer({ onClose, onApplied }: Props) {
  const { t } = useTranslation();
  const { lines, status, error, start, cancel } = useUpdateStream();
  const [applying, setApplying] = useState(false);
  const [applied,  setApplied]  = useState(false);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const { toast }  = useToast();

  useEffect(() => {
    void start();
    return () => cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  async function applyUpdates() {
    setApplying(true);
    try {
      await api.setupApplyUpdates();
      setApplied(true);
      toast(t('updateDrawer.successToast'), 'success');
      onApplied?.();
    } catch (err) {
      toast(t('updateDrawer.errorToast', { error: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setApplying(false);
    }
  }

  const displayStatus: UpdateStreamStatus | 'applying' | 'applied' =
    applying ? 'applying' : applied ? 'applied' : status;

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />

      <aside className={styles.drawer} role="dialog" aria-label={t('updateDrawer.ariaLabel')}>
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <StatusIcon status={displayStatus} />
            <span className={styles.title}>{t('updateDrawer.title')}</span>
          </div>
          <button className={styles.iconBtn} onClick={onClose} title={t('actions.close')}>
            <X size={16} />
          </button>
        </div>

        <div ref={scrollRef} className={styles.logArea}>
          {status === 'pulling' && lines.length === 0 && (
            <div className={styles.centeredMsg}>
              <Loader size={16} className={styles.spin} />
              {t('updateDrawer.pulling')}
            </div>
          )}

          {lines.map(({ key, line }) => (
            <div key={key} className={styles.logLine}>{line}</div>
          ))}

          {status === 'error' && (
            <div className={styles.errorMsg}>
              <AlertCircle size={13} />
              {error ?? t('updateDrawer.unknownError')}
            </div>
          )}

          {status === 'done' && !applied && (
            <div className={styles.doneMsg}>
              <CheckCircle size={13} />
              {t('updateDrawer.pullComplete')}
            </div>
          )}

          {applied && (
            <div className={styles.doneMsg}>
              <CheckCircle size={13} />
              {t('updateDrawer.containersRestarted')}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          {status === 'error' && (
            <button className={styles.retryBtn} onClick={() => void start()}>
              <RefreshCw size={12} />
              {t('actions.retry')}
            </button>
          )}
          {status === 'done' && !applied && (
            <button
              className={styles.applyBtn}
              onClick={() => void applyUpdates()}
              disabled={applying}
            >
              {applying
                ? <Loader size={12} className={styles.spin} />
                : <Rocket size={12} />
              }
              {applying ? t('updateDrawer.applying') : t('updateDrawer.applyUpdates')}
            </button>
          )}
          <span className={styles.lineCount}>
            {t('updateDrawer.nLines', { n: lines.length.toLocaleString() })}
          </span>
        </div>
      </aside>
    </>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'pulling' || status === 'applying') {
    return <Loader size={14} className={styles.spin} />;
  }
  if (status === 'done' || status === 'applied') {
    return <CheckCircle size={14} style={{ color: '#4ade80', flexShrink: 0 }} />;
  }
  if (status === 'error') {
    return <AlertCircle size={14} style={{ color: '#f87171', flexShrink: 0 }} />;
  }
  return <Download size={14} style={{ flexShrink: 0 }} />;
}
