import {
  LayoutDashboard,
  Film,
  MessageSquare,
  Settings,
} from 'lucide-react';
import styles from './Sidebar.module.css';
import type { View } from '@/lib/types';

const NAV_ITEMS: { id: View; label: string; Icon: React.ElementType }[] = [
  { id: 'dashboard', label: 'Dashboard',   Icon: LayoutDashboard },
  { id: 'library',   label: 'Library',     Icon: Film },
  { id: 'chat',      label: 'MCP Console', Icon: MessageSquare },
  { id: 'settings',  label: 'Settings',    Icon: Settings },
];

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  serverOnline: boolean;
}

export function Sidebar({ activeView, onViewChange, serverOnline }: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <div className={styles.brandIcon}>
          <img src="/logo.svg" alt="Mediabox" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        <div className={styles.brandText}>
          <div className={styles.brandName}>Mediabox</div>
          <div className={styles.brandVersion}>OS v2.1</div>
        </div>
      </div>

      <nav className={styles.nav}>
        <div className={styles.sectionLabel}>Navigation</div>
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={[styles.navItem, activeView === id && styles.active]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onViewChange(id)}
          >
            <Icon size={18} className={styles.navIcon} />
            {label}
          </button>
        ))}
      </nav>

      <div className={styles.footer}>
        <div className={styles.serverStatus}>
          <div
            className={[styles.dot, serverOnline ? styles.online : styles.offline]
              .filter(Boolean)
              .join(' ')}
          />
          <div className={styles.serverInfo}>
            <span className={styles.serverName}>Mediabox</span>
            <span className={styles.serverMeta}>
              {serverOnline ? 'MCP Connected' : 'MCP Offline'}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
