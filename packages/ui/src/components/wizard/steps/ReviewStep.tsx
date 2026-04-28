import type { WizardDraft } from '@/lib/wizard-types';
import styles from './ReviewStep.module.css';

interface Props {
  draft: WizardDraft;
}

export function ReviewStep({ draft }: Props) {
  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        Review your settings before deploying. The deploy pulls Docker images, starts each service,
        waits for them to become healthy, and wires up the API keys between them. Takes 3–8 minutes
        depending on your connection.
      </p>

      <div className={styles.summary}>
        <Section title="Deployment">
          <Row k="Mode"        v={draft.deployment.mode} />
          <Row k="Stack at"    v={draft.workDir} mono />
          <Row k="Image tag"   v={draft.deployment.imageTag} />
          {draft.deployment.mode !== 'local' && (
            <Row k="Domain" v={draft.deployment.baseDomain} />
          )}
        </Section>

        <Section title="System">
          <Row k="Timezone" v={draft.system.timezone} />
          <Row k="UID/GID"  v={`${draft.system.puid}:${draft.system.pgid}`} />
        </Section>

        <Section title="Media paths">
          <Row k="Movies" v={draft.paths.movies} mono />
          <Row k="TV"     v={draft.paths.tv}     mono />
          <Row k="Anime"  v={draft.paths.anime}  mono />
          <Row k="Music"  v={draft.paths.music}  mono />
        </Section>

        <Section title="Services">
          <Row k="Jellyfin admin" v={draft.services.jellyfinAdminUsername} />
          <Row k="qBittorrent"    v={draft.services.qbitPassword.length > 0 ? 'admin / ••• set' : 'no password'} />
          <Row k="PyLoad"         v="pyload / pyload (default)" />
          <Row k="Bazarr"         v={draft.services.bazarrEnabled ? 'enabled' : 'disabled'} />
        </Section>

        <Section title="AI">
          <Row k="Provider" v={draft.ai.provider === 'none' ? 'none' : draft.ai.provider} />
          {draft.ai.provider !== 'none' && (
            <Row k="API key" v={draft.ai.apiKey ? `••• ${draft.ai.apiKey.slice(-4)}` : 'missing'} mono />
          )}
        </Section>

        <Section title="Telegram">
          <Row k="Status" v={draft.telegram.enabled ? 'enabled' : 'disabled'} />
          {draft.telegram.enabled && (
            <>
              <Row k="Token" v={draft.telegram.botToken ? `••• ${draft.telegram.botToken.slice(-4)}` : 'missing'} mono />
              <Row k="Users" v={draft.telegram.allowedUserIds || 'anyone'} />
            </>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>{title}</h4>
      <dl className={styles.dl}>{children}</dl>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className={styles.dt}>{k}</dt>
      <dd className={[styles.dd, mono && styles.mono].filter(Boolean).join(' ')}>{v}</dd>
    </>
  );
}
