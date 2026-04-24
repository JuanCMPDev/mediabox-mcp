import { useEffect, useState } from 'react';
import styles from './TopBar.module.css';
import type { View } from '@/lib/types';

const VIEW_LABELS: Record<View, string> = {
  dashboard: 'Dashboard',
  library:   'Library',
  chat:      'MCP Console',
  settings:  'Settings',
};

interface TopBarProps {
  activeView: View;
  serverOnline: boolean;
}

export function TopBar({ activeView, serverOnline }: TopBarProps) {
  const [time, setTime] = useState(() => formatTime(new Date()));

  useEffect(() => {
    const id = setInterval(() => setTime(formatTime(new Date())), 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <div className={styles.windowControls}>
          <div className={`${styles.wc} ${styles.close}`} />
          <div className={`${styles.wc} ${styles.min}`} />
          <div className={`${styles.wc} ${styles.max}`} />
        </div>
      </div>

      <div className={styles.center} />

      <div className={styles.right}>
        <div className={styles.breadcrumb}>
          <span>Mediabox</span>
          <span>/</span>
          <span className={styles.breadcrumbCurrent}>{VIEW_LABELS[activeView]}</span>
        </div>
        <div
          className={[styles.statusDot, !serverOnline && styles.offline]
            .filter(Boolean)
            .join(' ')}
          title={serverOnline ? 'MCP server connected' : 'MCP server offline'}
        />
        <span className={styles.clock}>{time}</span>
      </div>
    </header>
  );
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
