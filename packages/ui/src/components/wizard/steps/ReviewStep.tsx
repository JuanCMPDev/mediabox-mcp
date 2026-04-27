import type { WizardDraft } from '@/lib/wizard-types';
import styles from './ReviewStep.module.css';

interface Props {
  draft: WizardDraft;
}

export function ReviewStep({ draft }: Props) {
  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        Revisá la configuración antes de iniciar el deploy. Este paso descarga las imágenes Docker,
        las inicia, espera a que cada servicio esté listo, y configura las API keys entre ellos.
        Tarda entre 3 y 8 minutos según tu conexión.
      </p>

      <div className={styles.summary}>
        <Section title="Despliegue">
          <Row k="Modo"            v={draft.deployment.mode} />
          <Row k="Stack en"        v={draft.workDir} mono />
          <Row k="Tag de imagen"   v={draft.deployment.imageTag} />
          {draft.deployment.mode !== 'local' && (
            <Row k="Dominio" v={draft.deployment.baseDomain} />
          )}
        </Section>

        <Section title="Sistema">
          <Row k="Zona horaria"  v={draft.system.timezone} />
          <Row k="UID/GID"       v={`${draft.system.puid}:${draft.system.pgid}`} />
        </Section>

        <Section title="Rutas de medios">
          <Row k="Películas" v={draft.paths.movies} mono />
          <Row k="Series"    v={draft.paths.tv}     mono />
          <Row k="Anime"     v={draft.paths.anime}  mono />
          <Row k="Música"    v={draft.paths.music}  mono />
        </Section>

        <Section title="Servicios">
          <Row k="Jellyfin admin" v={draft.services.jellyfinAdminUsername} />
          <Row k="qBittorrent"    v={draft.services.qbitPassword.length > 0 ? '••• definido' : 'sin contraseña'} />
          <Row k="PyLoad"         v={draft.services.pyloadUsername} />
          <Row k="Bazarr"         v={draft.services.bazarrEnabled ? 'activado' : 'desactivado'} />
        </Section>

        <Section title="AI">
          <Row k="Proveedor" v={draft.ai.provider === 'none' ? 'ninguno' : draft.ai.provider} />
          {draft.ai.provider !== 'none' && (
            <Row k="API key"  v={draft.ai.apiKey ? `••• ${draft.ai.apiKey.slice(-4)}` : 'falta'} mono />
          )}
        </Section>

        <Section title="Telegram">
          <Row k="Estado" v={draft.telegram.enabled ? 'activo' : 'desactivado'} />
          {draft.telegram.enabled && (
            <>
              <Row k="Token" v={draft.telegram.botToken ? `••• ${draft.telegram.botToken.slice(-4)}` : 'falta'} mono />
              <Row k="Usuarios" v={draft.telegram.allowedUserIds || 'cualquiera'} />
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
