import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Trash2, PauseCircle, PlayCircle, AlertCircle, Loader, CheckCircle } from 'lucide-react';
import { useLogStream, type LogStreamStatus } from '@/lib/use-log-stream';
import styles from './LogDrawer.module.css';

interface Props {
  service:     string;
  displayName: string;
  onClose:     () => void;
}

const TAIL_OPTIONS = [100, 200, 500, 1000] as const;

export function LogDrawer({ service, displayName, onClose }: Props) {
  const { t } = useTranslation();
  const { lines, status, error, open, close, clear } = useLogStream();
  const [tail,       setTail]       = useState<number>(200);
  const [autoScroll, setAutoScroll] = useState(true);
  const [search,     setSearch]     = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Open the stream on mount, restart when tail changes.
  useEffect(() => {
    void open(service, tail);
    return () => close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, tail]);

  // Auto-scroll to bottom when new lines arrive.
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const filtered = search.trim()
    ? lines.filter(l => l.line.toLowerCase().includes(search.toLowerCase()))
    : lines;

  return (
    <>
      {/* Backdrop */}
      <div className={styles.backdrop} onClick={onClose} />

      <aside className={styles.drawer} role="dialog" aria-label={`${displayName} logs`}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <StatusDot status={status} />
            <span className={styles.serviceName}>{displayName}</span>
            <span className={styles.headerSub}>{t('logDrawer.liveLogs')}</span>
          </div>
          <button className={styles.iconBtn} onClick={onClose} title={t('actions.close')}>
            <X size={16} />
          </button>
        </div>

        {/* Controls */}
        <div className={styles.controls}>
          <div className={styles.controlGroup}>
            <label className={styles.controlLabel}>{t('logDrawer.tail')}</label>
            <select
              className={styles.select}
              value={tail}
              onChange={e => setTail(Number(e.target.value))}
            >
              {TAIL_OPTIONS.map(n => (
                <option key={n} value={n}>{t('logDrawer.nLines', { n })}</option>
              ))}
            </select>
          </div>

          <div className={styles.controlGroup}>
            <input
              className={styles.searchInput}
              placeholder={t('logDrawer.filterPlaceholder')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <button
            className={styles.iconBtn}
            onClick={() => setAutoScroll(a => !a)}
            title={autoScroll ? t('logDrawer.pauseAutoScroll') : t('logDrawer.resumeAutoScroll')}
          >
            {autoScroll ? <PauseCircle size={15} /> : <PlayCircle size={15} />}
          </button>

          <button className={styles.iconBtn} onClick={clear} title={t('logDrawer.clear')}>
            <Trash2 size={15} />
          </button>
        </div>

        {/* Log area */}
        <div
          ref={scrollRef}
          className={styles.logArea}
          onScroll={e => {
            // If the user scrolls up manually, disable auto-scroll.
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && autoScroll) setAutoScroll(false);
          }}
        >
          {status === 'connecting' && (
            <div className={styles.centeredMsg}>
              <Loader size={16} className={styles.spin} />
              {t('logDrawer.connecting', { displayName })}
            </div>
          )}

          {status === 'error' && (
            <div className={styles.centeredMsg}>
              <AlertCircle size={16} />
              {error ?? t('logDrawer.unknownError')}
            </div>
          )}

          {filtered.map(({ key, ts, line }) => (
            <div key={key} className={styles.logLine}>
              <span className={styles.ts}>{formatTs(ts)}</span>
              <span className={styles.msg}>{stripDockerPrefix(line)}</span>
            </div>
          ))}

          {status === 'closed' && lines.length > 0 && (
            <div className={styles.eofMsg}>{t('logDrawer.endOfStream')}</div>
          )}

          {(status === 'live' || status === 'closed') && filtered.length === 0 && (
            <div className={styles.centeredMsg}>{search ? t('logDrawer.noLinesMatch') : t('logDrawer.noLines')}</div>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <StatusDot status={status} />
          <span className={styles.footerStatus}>{t(`status.${status}`)}</span>
          <span className={styles.lineCount}>{t('logDrawer.nLines', { n: lines.length.toLocaleString() })}</span>
          {(status === 'closed' || status === 'error') && (
            <button className={styles.retryBtn} onClick={() => void open(service, tail)}>
              {t('logDrawer.reconnect')}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: LogStreamStatus }) {
  const icon: Record<LogStreamStatus, React.ReactNode> = {
    idle:       <span className={`${styles.dot} ${styles.dotIdle}`} />,
    connecting: <Loader size={12} className={`${styles.dotIcon} ${styles.spin}`} />,
    live:       <CheckCircle size={12} className={`${styles.dotIcon} ${styles.dotLive}`} />,
    closed:     <span className={`${styles.dot} ${styles.dotClosed}`} />,
    error:      <AlertCircle size={12} className={`${styles.dotIcon} ${styles.dotError}`} />,
  };
  return <>{icon[status]}</>;
}

/** Format an ISO timestamp to HH:MM:SS.mmm */
function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    const ms = d.getMilliseconds().toString().padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return iso.slice(11, 23);
  }
}

/**
 * Strip the `servicename  | ` prefix that docker compose prepends to each line.
 * If --timestamps is on the format is: `servicename  | 2024-... actual message`
 * We strip `servicename  | ` and let the ts column show our own server timestamp.
 */
function stripDockerPrefix(line: string): string {
  const pipeIdx = line.indexOf(' | ');
  if (pipeIdx !== -1 && pipeIdx < 40) return line.slice(pipeIdx + 3);
  return line;
}
