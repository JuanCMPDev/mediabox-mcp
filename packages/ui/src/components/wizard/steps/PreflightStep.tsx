import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('wizard');
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
        {t('preflight.intro')}
      </p>

      <div className={styles.checks}>
        <Check
          label={t('preflight.dockerInstalled')}
          status={loading ? 'pending' : status?.installed ? 'ok' : 'fail'}
          detail={status?.version ?? undefined}
        />
        <Check
          label={t('preflight.daemonRunning')}
          status={loading ? 'pending' : status?.daemonRunning ? 'ok' : 'fail'}
          detail={!status?.daemonRunning && status?.installed ? t('preflight.startDesktop') : undefined}
        />
        <Check
          label={t('preflight.composeAvailable')}
          status={loading ? 'pending' : status?.composeAvailable ? 'ok' : 'fail'}
        />
      </div>

      {status && !loading && !(status.installed && status.daemonRunning && status.composeAvailable) && (
        <div className={styles.errorBox}>
          <AlertTriangle size={16} />
          <div>
            <strong>{t('preflight.cantContinue')}</strong>
            <p>{status.error || t('preflight.checkFailed')}</p>
            <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noopener" className={styles.link}>
              {t('preflight.installDocker')}
              <ExternalLink size={12} />
            </a>
          </div>
        </div>
      )}

      <div className={styles.retry}>
        <GlassButton variant="secondary" size="sm" onClick={probe} disabled={loading}>
          {loading ? <Loader2 size={14} className={styles.spin} /> : null}
          {t('preflight.retry')}
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