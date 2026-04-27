import { useEffect, useState } from 'react';
import styles from './TopBar.module.css';
import type { View } from '@/lib/types';
import { closeWindow, minimizeWindow, toggleMaximize } from '@/lib/tauri-bridge';

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
    <header className={styles.topbar} data-tauri-drag-region>
      <div className={styles.left}>
        <div className={styles.windowControls}>
          <button
            type="button"
            className={`${styles.wc} ${styles.close}`}
            onClick={() => void closeWindow()}
            aria-label="Cerrar"
            title="Cerrar"
          />
          <button
            type="button"
            className={`${styles.wc} ${styles.min}`}
            onClick={() => void minimizeWindow()}
            aria-label="Minimizar"
            title="Minimizar"
          />
          <button
            type="button"
            className={`${styles.wc} ${styles.max}`}
            onClick={() => void toggleMaximize()}
            aria-label="Maximizar"
            title="Maximizar"
          />
        </div>
      </div>

      <div className={styles.center} data-tauri-drag-region />

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
