import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassCard }   from '@/components/atoms/GlassCard';
import { GlassButton } from '@/components/atoms/GlassButton';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import styles from './StepShell.module.css';

interface StepShellProps {
  stepIndex:  number;
  totalSteps: number;
  title:      string;
  subtitle?:  string;
  children:   ReactNode;

  canGoBack?:    boolean;
  canGoForward?: boolean;
  onBack?:       () => void;
  onForward?:    () => void;

  /** Override the default "Continue" / "Finish" button label. */
  forwardLabel?: string;
  /** Override the back button label, defaults to "Back". */
  backLabel?:    string;
  /** Hide nav entirely (used in the deploy-progress step). */
  hideNav?:      boolean;
}

export function StepShell({
  stepIndex,
  totalSteps,
  title,
  subtitle,
  children,
  canGoBack = true,
  canGoForward = true,
  onBack,
  onForward,
  forwardLabel,
  backLabel,
  hideNav = false,
}: StepShellProps) {
  const { t } = useTranslation('wizard');
  const progressPct = ((stepIndex + 1) / totalSteps) * 100;
  const isLast      = stepIndex === totalSteps - 1;

  return (
    <div className={styles.shell}>
      <GlassCard className={styles.card} level={3}>
        <header className={styles.header}>
          <div className={styles.progress}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
            </div>
            <span className={styles.progressLabel}>
              {t('shell.stepProgress', { current: stepIndex + 1, total: totalSteps })}
            </span>
          </div>
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </header>

        <div className={styles.body}>{children}</div>

        {!hideNav && (
          <footer className={styles.footer}>
            <GlassButton
              variant="secondary"
              onClick={onBack}
              disabled={!canGoBack}
            >
              <ChevronLeft size={16} />
              {backLabel ?? t('buttons.back')}
            </GlassButton>
            <GlassButton
              variant="primary"
              onClick={onForward}
              disabled={!canGoForward}
            >
              {forwardLabel ?? (isLast ? t('buttons.finish') : t('buttons.continue'))}
              {!isLast && <ChevronRight size={16} />}
            </GlassButton>
          </footer>
        )}
      </GlassCard>
    </div>
  );
}