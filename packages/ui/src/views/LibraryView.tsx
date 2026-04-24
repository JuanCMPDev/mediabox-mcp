import { Library } from 'lucide-react';
import styles from './LibraryView.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';

export function LibraryView() {
  return (
    <div className={styles.view}>
      <GlassCard className={styles.placeholder}>
        <div className={styles.icon}>
          <Library size={28} color="var(--primary)" />
        </div>
        <div className={styles.title}>Library Browser</div>
        <div className={styles.subtitle}>
          Media browsing, search, and file management will be available in Phase 2.2
          when the UI connects to the MCP server.
        </div>
        <div className={styles.badge}>Coming in Phase 2.2</div>
      </GlassCard>
    </div>
  );
}
