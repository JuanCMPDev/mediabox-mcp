import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, AlertTriangle, ExternalLink } from 'lucide-react';
import { checkDocker } from '@/lib/tauri-bridge';
import { GlassButton } from '@/components/atoms/GlassButton';
import styles from './PreflightStep.module.css';

interface DockerStatus {
  installed:        boolean;
  daemonRunning:    boolean;
  composeAvailable: boolean;
  version:          string | null;
  error:            string | null;
}

interface Props {
  onReady: (ready: boolean) => void;
}

export function PreflightStep({ onReady }: Props) {
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const probe = async () => {
    setLoading(true);
    try {
      const s = await checkDocker();
      setStatus(s);
      onReady(s.installed && s.daemonRunning && s.composeAvailable);
    } catch (err) {
      setStatus({
        installed: false,
        daemonRunning: false,
        composeAvailable: false,
        version: null,
        error: err instanceof Error ? err.message : String(err),
      });
      onReady(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.preflight}>
      <p className={styles.intro}>
        Mediabox OS necesita Docker corriendo en tu máquina para orquestar Jellyfin,
        Sonarr, Radarr y el resto del stack. Vamos a hacer un chequeo rápido.
      </p>

      <div className={styles.checks}>
        <Check
          label="Docker instalado"
          status={loading ? 'pending' : status?.installed ? 'ok' : 'fail'}
          detail={status?.version ?? undefined}
        />
        <Check
          label="Docker daemon corriendo"
          status={loading ? 'pending' : status?.daemonRunning ? 'ok' : 'fail'}
          detail={!status?.daemonRunning && status?.installed ? 'Iniciá Docker Desktop o systemctl start docker' : undefined}
        />
        <Check
          label="Plugin docker compose"
          status={loading ? 'pending' : status?.composeAvailable ? 'ok' : 'fail'}
        />
      </div>

      {status && !loading && !(status.installed && status.daemonRunning && status.composeAvailable) && (
        <div className={styles.errorBox}>
          <AlertTriangle size={16} />
          <div>
            <strong>No podemos continuar todavía.</strong>
            <p>{status.error || 'Algún chequeo falló. Revisá Docker Desktop y volvé a intentar.'}</p>
            <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noopener" className={styles.link}>
              Instalar Docker
              <ExternalLink size={12} />
            </a>
          </div>
        </div>
      )}

      <div className={styles.retry}>
        <GlassButton variant="secondary" size="sm" onClick={probe} disabled={loading}>
          {loading ? <Loader2 size={14} className={styles.spin} /> : null}
          Reintentar chequeo
        </GlassButton>
      </div>
    </div>
  );
}

function Check({ label, status, detail }: { label: string; status: 'pending' | 'ok' | 'fail'; detail?: string }) {
  return (
    <div className={styles.check}>
      <span className={styles.checkIcon}>
        {status === 'pending' && <Loader2 size={18} className={styles.spin} />}
        {status === 'ok'      && <CheckCircle2 size={18} color="var(--primary)" />}
        {status === 'fail'    && <XCircle size={18} color="var(--error)" />}
      </span>
      <div className={styles.checkBody}>
        <span className={styles.checkLabel}>{label}</span>
        {detail && <span className={styles.checkDetail}>{detail}</span>}
      </div>
    </div>
  );
}
