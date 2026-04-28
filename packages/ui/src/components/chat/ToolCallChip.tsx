import { Check, X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './ToolCallChip.module.css';
import type { ToolCallRecord } from '@/lib/types';

const KNOWN_TOOLS = new Set([
  'server_info',
  'media_query',
  'library_ops',
  'series',
  'movies',
  'downloads',
  'optimize',
  'maintenance',
]);

interface ToolCallChipProps {
  record: ToolCallRecord;
}

export function ToolCallChip({ record }: ToolCallChipProps) {
  const { t } = useTranslation();
  const label = KNOWN_TOOLS.has(record.name)
    ? t(`chat.tools.${record.name}`)
    : t('chat.tools.fallback', { name: record.name });

  const stateClass =
    record.status === 'ok'    ? styles.ok    :
    record.status === 'error' ? styles.error : styles.running;

  const title =
    record.status === 'error' && record.error ? record.error :
    record.status !== 'running' && record.durationMs !== undefined
      ? t('chat.toolHistory.duration', { ms: record.durationMs })
      : '';

  return (
    <span className={[styles.chip, stateClass].join(' ')} title={title}>
      <span className={styles.icon}>
        {record.status === 'running' && <Loader2 size={11} className={styles.spin} />}
        {record.status === 'ok'      && <Check     size={11} />}
        {record.status === 'error'   && <X         size={11} />}
      </span>
      <span className={styles.label}>{label}</span>
      {record.status !== 'running' && record.durationMs !== undefined && (
        <span className={styles.duration}>{formatDuration(record.durationMs)}</span>
      )}
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
