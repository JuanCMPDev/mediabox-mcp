import { useEffect, useState } from 'react';
import { ExternalLink, CheckCircle, AlertCircle, Loader, Search } from 'lucide-react';
import { GlassButton } from '@/components/atoms/GlassButton';
import { api } from '@/lib/api';
import { openExternal } from '@/lib/tauri-bridge';
import styles from './ProwlarrSetupStep.module.css';

interface Props {
  onContinue: () => void;
  onSkip:     () => void;
}

const DEFAULT_URL  = 'http://localhost:9696';
const POLL_INTERVAL_MS = 3_000;

export function ProwlarrSetupStep({ onContinue, onSkip }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [url,   setUrl]   = useState<string>(DEFAULT_URL);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const result = await api.setupProwlarrIndexers();
        if (cancelled) return;
        setCount(result.count);
        setUrl(result.url || DEFAULT_URL);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const ready = count !== null && count > 0;

  return (
    <div className={styles.container}>
      <p className={styles.intro}>
        Sonarr and Radarr need at least one indexer in Prowlarr to search. Open Prowlarr,
        add any indexer that works for you, and you&apos;ll be able to continue.
      </p>

      <div className={styles.openBtnRow}>
        <GlassButton variant="primary" onClick={() => void openExternal(url)}>
          <ExternalLink size={14} />
          Open Prowlarr
        </GlassButton>
        <code className={styles.url}>{url.replace(/^https?:\/\//, '')}</code>
      </div>

      <div
        className={[
          styles.statusCard,
          ready  && styles.statusCardOk,
          error  && styles.statusCardError,
        ].filter(Boolean).join(' ')}
      >
        {count === null && !error && (
          <>
            <Loader size={16} className={styles.spin} />
            <span>Waiting for Prowlarr…</span>
          </>
        )}
        {error && (
          <>
            <AlertCircle size={16} className={styles.statusError} />
            <span>{error}</span>
          </>
        )}
        {!error && count === 0 && (
          <>
            <Search size={16} className={styles.statusWarn} />
            <span><strong>0 indexers</strong> · Open Prowlarr and add at least one.</span>
          </>
        )}
        {!error && count !== null && count > 0 && (
          <>
            <CheckCircle size={16} className={styles.statusOk} />
            <span>
              <strong>{count} indexer{count > 1 ? 's' : ''}</strong> configured. Ready to continue.
            </span>
          </>
        )}
      </div>

      <p className={styles.tip}>
        Tip: if an indexer is blocked by Cloudflare, tag it <code>flaresolverr</code> — we already
        wired up the proxy, and that tag routes its traffic through FlareSolverr automatically.
      </p>

      <div className={styles.actions}>
        <button type="button" className={styles.skipLink} onClick={onSkip}>
          Skip — I&apos;ll do this later
        </button>
        <GlassButton variant="primary" onClick={onContinue} disabled={!ready}>
          Continue
        </GlassButton>
      </div>
    </div>
  );
}
