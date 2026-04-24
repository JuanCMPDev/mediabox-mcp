import { Settings } from 'lucide-react';
import styles from './SettingsView.module.css';
import { GlassCard } from '@/components/atoms/GlassCard';

export function SettingsView() {
  return (
    <div className={styles.view}>
      <GlassCard className={styles.placeholder}>
        <div className={styles.icon}>
          <Settings size={28} color="var(--tertiary)" />
        </div>
        <div className={styles.title}>Settings</div>
        <div className={styles.subtitle}>
          Server configuration, LLM provider selection, and Ollama local AI setup
          will be available in Phase 3.
        </div>
        <div className={styles.badge}>Coming in Phase 3</div>
      </GlassCard>
    </div>
  );
}
