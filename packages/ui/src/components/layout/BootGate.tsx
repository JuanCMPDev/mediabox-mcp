import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { loadRuntimeConfig } from '@/lib/runtime-config';
import styles from './BootGate.module.css';

type BootState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'failed'; error: string };

interface Props {
  children: ReactNode;
}

/**
 * Withholds the app render until the runtime config (apiUrl + internalApiKey)
 * has been resolved. Under Tauri this means waiting for the sidecar to bind
 * to its random port. In browser dev this is instantaneous.
 */
export function BootGate({ children }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<BootState>({ status: 'loading' });

  useEffect(() => {
    loadRuntimeConfig()
      .then(() => setState({ status: 'ready' }))
      .catch(err => setState({
        status: 'failed',
        error:  err instanceof Error ? err.message : 'Unknown boot error',
      }));
  }, []);

  if (state.status === 'ready') {
    return <>{children}</>;
  }

  return (
    <div className={styles.gate}>
      <div className={styles.card}>
        <div className={styles.spinner} aria-hidden />
        {state.status === 'loading' && (
          <>
            <h1 className={styles.title}>{t('boot.starting')}</h1>
            <p className={styles.subtitle}>{t('boot.subtitle')}</p>
          </>
        )}
        {state.status === 'failed' && (
          <>
            <h1 className={styles.titleError}>{t('boot.failed')}</h1>
            <p className={styles.subtitle}>{state.error}</p>
          </>
        )}
      </div>
    </div>
  );
}
