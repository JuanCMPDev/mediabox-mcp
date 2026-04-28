import {
  LayoutDashboard,
  Film,
  MessageSquare,
  Settings,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import styles from './Sidebar.module.css';
import type { View } from '@/lib/types';

interface NavItem {
  /** Translation key under `nav.*` — resolved via `t()` at render time. */
  id:    View;
  Icon:  React.ElementType;
  beta?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', Icon: LayoutDashboard },
  { id: 'library',   Icon: Film },
  { id: 'chat',      Icon: MessageSquare, beta: true },
  { id: 'settings',  Icon: Settings },
];

interface SidebarProps {
  activeView:   View;
  onViewChange: (view: View) => void;
  serverOnline: boolean;
  /** Hide the chat tab when no LLM provider is configured. */
  aiEnabled:    boolean;
}

export function Sidebar({ activeView, onViewChange, serverOnline, aiEnabled }: SidebarProps) {
  const { t } = useTranslation();
  const visibleItems = aiEnabled ? NAV_ITEMS : NAV_ITEMS.filter(item => item.id !== 'chat');

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
        <div className={styles.sectionLabel}>{t('sidebar.navigation')}</div>
        {visibleItems.map(({ id, Icon, beta }) => (
          <button
            key={id}
            type="button"
            className={[styles.navItem, activeView === id && styles.active]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onViewChange(id)}
          >
            <Icon size={18} className={styles.navIcon} />
            <span>{t(`nav.${id}`)}</span>
            {beta && <span className={styles.betaBadge}>Beta</span>}
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
              {serverOnline ? t('sidebar.mcpConnected') : t('sidebar.mcpOffline')}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
