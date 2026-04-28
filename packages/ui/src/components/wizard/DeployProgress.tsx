import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import type { DeployState } from '@/lib/use-deploy-stream';
import { GlassButton } from '@/components/atoms/GlassButton';
import styles from './DeployProgress.module.css';

interface Props {
  state:    DeployState;
  onCancel: () => void;
  onFinish: () => void;
  onRetry:  () => void;
}

// We'll map phases inside the component to have access to `t`
const usePhaseLabels = (t: any): Record<string, string> => ({
  'config:validate':            t('deployProgress.phases.configValidate'),
  'generate:directories':       t('deployProgress.phases.generateDirectories'),
  'generate:env':               t('deployProgress.phases.generateEnv'),
  'generate:compose':           t('deployProgress.phases.generateCompose'),
  'generate:qbittorrent':       t('deployProgress.phases.generateQbittorrent'),
  'generate:caddy':             t('deployProgress.phases.generateCaddy'),
  'deploy:prepare-images':      t('deployProgress.phases.deployPrepareImages'),
  'deploy:start':               t('deployProgress.phases.deployStart'),
  'deploy:health':              t('deployProgress.phases.deployHealth'),
  'discover:api-keys':          t('deployProgress.phases.discoverApiKeys'),
  'configure:jellyfin':         t('deployProgress.phases.configureJellyfin'),
  'configure:sonarr':           t('deployProgress.phases.configureSonarr'),
  'configure:radarr':           t('deployProgress.phases.configureRadarr'),
  'configure:prowlarr':         t('deployProgress.phases.configureProwlarr'),
  'configure:qbittorrent':      t('deployProgress.phases.configureQbittorrent'),
  'configure:flaresolverr':     t('deployProgress.phases.configureFlaresolverr'),
  'configure:arr-auth':         t('deployProgress.phases.configureArrAuth'),
  'configure:jellyfin-libraries': t('deployProgress.phases.configureJellyfinLibraries'),
  'write:env-update':           t('deployProgress.phases.writeEnvUpdate'),
  'deploy:restart':             t('deployProgress.phases.deployRestart'),
});

export function DeployProgress({ state, onCancel, onFinish, onRetry }: Props) {
  const { t } = useTranslation('wizard');
  const phaseLabels = usePhaseLabels(t);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll log to the bottom on each new event.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [state.events.length]);

  const lastPhase = state.events.length > 0
    ? state.events[state.events.length - 1]
    : null;

  const showFinishedSummary = state.phase === 'finished' && state.ok;
  const showFailedSummary   = state.phase === 'finished' && !state.ok;
  const showHardError       = state.phase === 'error';

  return (
    <div className={styles.progress}>
      <div className={styles.header}>
        {state.phase === 'starting' && <Loader2 size={20} className={styles.spin} />}
        {state.phase === 'running'  && <Loader2 size={20} className={styles.spin} />}
        {showFinishedSummary && <CheckCircle2 size={20} color="var(--primary)" />}
        {showFailedSummary   && <AlertTriangle size={20} color="var(--error)" />}
        {showHardError       && <XCircle size={20} color="var(--error)" />}
        <div>
          <strong>
            {state.phase === 'starting' && t('deployProgress.status.starting')}
            {state.phase === 'running'  && lastPhase && 'phase' in lastPhase
              ? (phaseLabels[lastPhase.phase] ?? lastPhase.phase)
              : null}
            {showFinishedSummary && t('deployProgress.status.done')}
            {showFailedSummary   && t('deployProgress.status.failed')}
            {showHardError       && t('deployProgress.status.error')}
          </strong>
          {state.phase === 'finished' && state.durationMs !== null && (
            <p className={styles.muted}>
              {t('deployProgress.summary.total', { seconds: (state.durationMs / 1000).toFixed(1) })}
              {state.warnings.length > 0 && ` ${t(state.warnings.length === 1 ? 'deployProgress.summary.warnings' : 'deployProgress.summary.warningsPlural', { count: state.warnings.length })}`}
            </p>
          )}
          {showHardError && state.error && (
            <p className={styles.error}>{state.error}</p>
          )}
        </div>
      </div>

      <div className={styles.log} ref={scrollRef}>
        {state.events.length === 0 && state.phase !== 'error' && (
          <div className={styles.logEmpty}>{t('deployProgress.waiting')}</div>
        )}
        {state.events.map((evt, i) => (
          <LogLine key={i} event={evt} phaseLabels={phaseLabels} t={t} />
        ))}
      </div>

      <div className={styles.footer}>
        {(state.phase === 'starting' || state.phase === 'running') && (
          <GlassButton variant="secondary" onClick={onCancel}>{t('deployProgress.btn.cancel')}</GlassButton>
        )}
        {showFinishedSummary && (
          <GlassButton variant="primary" onClick={onFinish}>{t('buttons.continue')}</GlassButton>
        )}
        {(showFailedSummary || showHardError) && (
          <>
            <GlassButton variant="secondary" onClick={onCancel}>{t('deployProgress.btn.backToWizard')}</GlassButton>
            <GlassButton variant="primary" onClick={onRetry}>{t('deployProgress.btn.retry')}</GlassButton>
          </>
        )}
      </div>
    </div>
  );
}

function LogLine({ event, phaseLabels, t }: {
  event:       DeployState['events'][number];
  phaseLabels: Record<string, string>;
  t:           (key: string) => string;
}) {
  if (event.kind === 'log') {
    return <div className={[styles.line, styles.logLine].join(' ')}>{event.message}</div>;
  }
  const phaseLabel = ('phase' in event && phaseLabels[event.phase]) || ('phase' in event ? event.phase : '');
  // event.kind is one of start/progress/success/warn/error — translated via
  // the wizard bundle so the log feels native instead of mixing English
  // labels into a Spanish UI. The `event.message` body still arrives in
  // English from @mediabox/core's orchestrator (deferred to a follow-up
  // i18n pass on the backend).
  const kindLabel = t(`deployProgress.kinds.${event.kind}`);
  return (
    <div className={[styles.line, styles[event.kind] ?? ''].filter(Boolean).join(' ')}>
      <span className={styles.lineKind}>{kindLabel}</span>
      <span className={styles.linePhase}>{phaseLabel}</span>
      <span className={styles.lineMsg}>{event.message}</span>
    </div>
  );
}