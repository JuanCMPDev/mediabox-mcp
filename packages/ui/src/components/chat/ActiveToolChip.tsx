import { useTranslation } from 'react-i18next';
import styles from './ActiveToolChip.module.css';

// Maps virtual tool name → translation key under chat.tools.<name>. Tools
// the LLM can hit but that we haven't given a friendly label for fall back
// to "<name>…" via chat.tools.fallback.
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

export function ActiveToolChip({ name }: { name: string }) {
  const { t } = useTranslation();
  const label = KNOWN_TOOLS.has(name)
    ? t(`chat.tools.${name}`)
    : t('chat.tools.fallback', { name });
  return (
    <div className={styles.chip}>
      <div className={styles.spinner} />
      <span>{label}</span>
    </div>
  );
}
