import { useEffect, useRef } from 'react';
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

const PHASE_LABELS: Record<string, string> = {
  'config:validate':            'Validando configuración',
  'generate:directories':       'Creando directorios',
  'generate:env':               'Generando .env',
  'generate:compose':           'Generando docker-compose.yml',
  'generate:qbittorrent':       'Pre-configurando qBittorrent',
  'generate:caddy':             'Generando Caddyfile',
  'deploy:prepare-images':      'Descargando imágenes Docker',
  'deploy:start':               'Iniciando contenedores',
  'deploy:health':              'Esperando que los servicios estén listos',
  'discover:api-keys':          'Descubriendo API keys',
  'configure:jellyfin':         'Configurando Jellyfin',
  'configure:sonarr':           'Configurando Sonarr',
  'configure:radarr':           'Configurando Radarr',
  'configure:prowlarr':         'Configurando Prowlarr',
  'configure:qbittorrent':      'Conectando qBittorrent',
  'configure:flaresolverr':     'Conectando FlareSolverr',
  'configure:arr-auth':         'Configurando autenticación entre servicios',
  'configure:jellyfin-libraries': 'Creando bibliotecas en Jellyfin',
  'write:env-update':           'Actualizando .env con keys descubiertas',
  'deploy:restart':             'Reiniciando contenedores',
};

export function DeployProgress({ state, onCancel, onFinish, onRetry }: Props) {
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
            {state.phase === 'starting' && 'Preparando deploy…'}
            {state.phase === 'running'  && lastPhase && 'phase' in lastPhase
              ? (PHASE_LABELS[lastPhase.phase] ?? lastPhase.phase)
              : null}
            {showFinishedSummary && '¡Listo! Stack desplegado.'}
            {showFailedSummary   && 'Deploy completado con errores'}
            {showHardError       && 'Falló el deploy'}
          </strong>
          {state.phase === 'finished' && state.durationMs !== null && (
            <p className={styles.muted}>
              Total: {(state.durationMs / 1000).toFixed(1)}s
              {state.warnings.length > 0 && ` · ${state.warnings.length} advertencias`}
            </p>
          )}
          {showHardError && state.error && (
            <p className={styles.error}>{state.error}</p>
          )}
        </div>
      </div>

      <div className={styles.log} ref={scrollRef}>
        {state.events.length === 0 && state.phase !== 'error' && (
          <div className={styles.logEmpty}>Esperando primer evento…</div>
        )}
        {state.events.map((evt, i) => (
          <LogLine key={i} event={evt} />
        ))}
      </div>

      <div className={styles.footer}>
        {(state.phase === 'starting' || state.phase === 'running') && (
          <GlassButton variant="secondary" onClick={onCancel}>Cancelar</GlassButton>
        )}
        {showFinishedSummary && (
          <GlassButton variant="primary" onClick={onFinish}>Abrir el dashboard</GlassButton>
        )}
        {(showFailedSummary || showHardError) && (
          <>
            <GlassButton variant="secondary" onClick={onCancel}>Volver al wizard</GlassButton>
            <GlassButton variant="primary" onClick={onRetry}>Reintentar</GlassButton>
          </>
        )}
      </div>
    </div>
  );
}

function LogLine({ event }: { event: DeployState['events'][number] }) {
  if (event.kind === 'log') {
    return <div className={[styles.line, styles.logLine].join(' ')}>{event.message}</div>;
  }
  const phaseLabel = ('phase' in event && PHASE_LABELS[event.phase]) || ('phase' in event ? event.phase : '');
  return (
    <div className={[styles.line, styles[event.kind] ?? ''].filter(Boolean).join(' ')}>
      <span className={styles.lineKind}>{event.kind}</span>
      <span className={styles.linePhase}>{phaseLabel}</span>
      <span className={styles.lineMsg}>{event.message}</span>
    </div>
  );
}
