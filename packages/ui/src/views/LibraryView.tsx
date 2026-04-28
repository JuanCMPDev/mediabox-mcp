import { Film, Tv, Sparkles, Music, FolderOpen, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassCard } from '@/components/atoms/GlassCard';
import { GlassButton } from '@/components/atoms/GlassButton';
import { useSetupInfo } from '@/lib/queries';
import { openPath } from '@/lib/tauri-bridge';
import { useToast } from '@/lib/toast';
import styles from './LibraryView.module.css';

interface FolderCard {
  key:   'movies' | 'tv' | 'anime' | 'music';
  labelKey: string;
  icon:  React.ReactNode;
}

const FOLDERS: FolderCard[] = [
  { key: 'movies', labelKey: 'library.movies', icon: <Film     size={18} /> },
  { key: 'tv',     labelKey: 'library.tv',     icon: <Tv       size={18} /> },
  { key: 'anime',  labelKey: 'library.anime',  icon: <Sparkles size={18} /> },
  { key: 'music',  labelKey: 'library.music',  icon: <Music    size={18} /> },
];

export function LibraryView() {
  const { data: info, isLoading } = useSetupInfo();
  const { t } = useTranslation();

  if (isLoading || !info) {
    return (
      <div className={styles.view}>
        <div className={styles.empty}>
          <Loader size={20} className={styles.spin} />
          {t('library.loading')}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t('library.title')}</h1>
        <p className={styles.subtitle}>
          {t('library.subtitle')}
        </p>
      </header>

      <div className={styles.grid}>
        {FOLDERS.map(folder => (
          <FolderTile
            key={folder.key}
            label={t(folder.labelKey)}
            icon={folder.icon}
            path={resolvePath(info.stack.workDir, info.paths[folder.key])}
          />
        ))}
      </div>

      <div className={styles.hint}>
        <strong>{t('library.tip')}</strong> {t('library.tipText')}
      </div>
    </div>
  );
}

interface FolderTileProps {
  label: string;
  icon:  React.ReactNode;
  path:  string;
}

function FolderTile({ label, icon, path }: FolderTileProps) {
  const { toast } = useToast();
  const { t } = useTranslation();
  const open = async () => {
    if (!path) return;
    try {
      await openPath(path);
    } catch (err) {
      toast(t('library.openError', { label, error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  return (
    <GlassCard className={styles.card} onClick={() => void open()}>
      <div className={styles.cardHeader}>
        <div className={styles.cardIcon}>{icon}</div>
        <span className={styles.cardName}>{label}</span>
      </div>
      <code className={styles.cardPath}>{path || t('library.notSet')}</code>
      <div className={styles.cardActions} onClick={e => e.stopPropagation()}>
        <GlassButton variant="secondary" size="sm" onClick={() => void open()} disabled={!path}>
          <FolderOpen size={13} />
          {t('actions.open')}
        </GlassButton>
      </div>
    </GlassCard>
  );
}

/**
 * Resolve a media path. Wizard inputs allow either absolute paths
 * (e.g. `D:\media\movies`, `/srv/media/movies`) or paths relative to the
 * stack folder (`./media/movies`). For relative paths we join against the
 * stack workDir, normalising every separator to whatever the workDir uses
 * — explorer.exe falls back to Documents on a mixed-separator path like
 * `D:\stack/media/movies`.
 */
function resolvePath(workDir: string | null, raw: string): string {
  if (!raw) return '';

  const isAbsolute =
    /^[a-zA-Z]:[\\/]/.test(raw)  // Windows drive
    || raw.startsWith('/')        // POSIX root
    || raw.startsWith('\\\\');    // Windows UNC

  if (isAbsolute) return normaliseSeparators(raw);
  if (!workDir) return raw;

  const isWindows = workDir.includes('\\');
  const sep       = isWindows ? '\\' : '/';

  const cleanWork    = workDir.replace(/[\\/]+$/, '');
  const stripped     = raw.replace(/^\.[\\/]/, '');           // drop leading "./"
  const reSeparated  = isWindows
    ? stripped.replace(/\//g, '\\')
    : stripped.replace(/\\/g, '/');

  return `${cleanWork}${sep}${reSeparated}`;
}

function normaliseSeparators(p: string): string {
  // If the path looks like Windows (has a drive letter or backslashes),
  // normalise to backslashes; otherwise leave alone.
  if (/^[a-zA-Z]:/.test(p) || p.includes('\\')) {
    return p.replace(/\//g, '\\');
  }
  return p;
}
