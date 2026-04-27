import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink, RefreshCw, FolderOpen, Eye, EyeOff,
  Save, RotateCw, Power, Play, AlertTriangle, Trash2,
} from 'lucide-react';

import { GlassCard }   from '@/components/atoms/GlassCard';
import { GlassButton } from '@/components/atoms/GlassButton';
import { GlassInput }  from '@/components/atoms/GlassInput';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import { Skeleton }    from '@/components/atoms/Skeleton';

import { api }              from '@/lib/api';
import { useSetupInfo }     from '@/lib/queries';
import { useToast }         from '@/lib/toast';
import {
  openExternal, confirmDialog, resetAppState, restartSidecar,
} from '@/lib/tauri-bridge';
import { reloadRuntimeConfig } from '@/lib/runtime-config';
import type { SetupInfo, ServiceCreds } from '@mediabox/contracts';

import styles from './SettingsView.module.css';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  Top-level view
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export function SettingsView() {
  const { data: info, isLoading, refetch } = useSetupInfo();

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Configuración</h1>
          <p className={styles.subtitle}>
            Cambios afectan al stack desplegado. Los containers que dependan de cada
            ajuste se reinician automáticamente al guardar.
          </p>
        </div>
        <GlassButton variant="secondary" size="sm" onClick={() => void refetch()}>
          <RefreshCw size={14} />
          Refrescar
        </GlassButton>
      </header>

      {isLoading && <SettingsSkeleton />}

      {info && (
        <>
          <StackOverview info={info} />
          <AIProviderSection info={info} />
          <TelegramSection info={info} />
          <ServicePasswordsSection info={info} />
          <ServicesLiveSection info={info} />
          <SystemSection info={info} />
          <StackLifecycleSection />
          <AdvancedSection info={info} />
        </>
      )}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <>
      {[0, 1, 2, 3].map(i => (
        <GlassCard key={i} className={styles.section}>
          <Skeleton style={{ width: 140, height: 14, marginBottom: 12 }} />
          <Skeleton style={{ width: '100%', height: 32, marginBottom: 8 }} />
          <Skeleton style={{ width: '60%', height: 32 }} />
        </GlassCard>
      ))}
    </>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  Sections
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function StackOverview({ info }: { info: SetupInfo }) {
  return (
    <Section title="Estado del stack">
      <Row k="Ubicación"      v={info.stack.workDir ?? '—'} mono />
      <Row k="Modo"           v={info.stack.deploymentMode} />
      <Row k="Tag de imagen"  v={info.stack.imageTag} mono />
      {info.stack.baseDomain && <Row k="Dominio base" v={info.stack.baseDomain} />}
      <Row k="Versión app"    v={info.app.version} mono />
    </Section>
  );
}

// ─── AI provider (editable) ──────────────────────────────────────────────────

function AIProviderSection({ info }: { info: SetupInfo }) {
  const [provider, setProvider] = useState(info.ai.provider);
  const [apiKey, setApiKey]     = useState('');
  const [model, setModel]       = useState(info.ai.model ?? '');
  const [saving, setSaving]     = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const dirty =
    provider !== info.ai.provider
    || apiKey.trim().length > 0
    || (model !== (info.ai.model ?? ''));

  async function save() {
    setSaving(true);
    try {
      const updates: Record<string, string> = {
        LLM_PROVIDER: provider === 'none' ? '' : provider,
        LLM_MODEL: model.trim(),
      };
      if (provider === 'openrouter' && apiKey.trim()) {
        updates.OPENROUTER_API_KEY = apiKey.trim();
        updates.GOOGLE_AI_API_KEY  = '';
      } else if (provider === 'google' && apiKey.trim()) {
        updates.GOOGLE_AI_API_KEY  = apiKey.trim();
        updates.OPENROUTER_API_KEY = '';
      } else if (provider === 'none') {
        updates.OPENROUTER_API_KEY = '';
        updates.GOOGLE_AI_API_KEY  = '';
      }
      const result = await api.setupPatchEnv(updates);
      if (result.errors.length > 0) {
        toast(`Error: ${result.errors[0]!.message}`, 'error');
        return;
      }
      // Restart docker containers + sidecar (for chat to pick up new key)
      await applyRestarts(result.restartRequired);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      setApiKey('');
      toast('Configuración de AI actualizada', 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Asistente AI" subtitle="Cambios reinician el chat de la app y el bot de Telegram.">
      <div className={styles.formField}>
        <label className={styles.label}>Proveedor</label>
        <SegmentedControl
          value={provider}
          onChange={v => setProvider(v as typeof provider)}
          options={[
            { value: 'none',       label: 'Sin AI' },
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'google',     label: 'Google AI' },
          ]}
        />
      </div>

      {provider !== 'none' && (
        <>
          <div className={styles.formField}>
            <label className={styles.label}>
              API key
              {info.ai.hasKey && info.ai.provider === provider && (
                <span className={styles.labelHint}>configurada — dejá vacío para mantener</span>
              )}
            </label>
            <GlassInput
              value={apiKey}
              onChange={setApiKey}
              placeholder={info.ai.hasKey && info.ai.provider === provider
                ? '•••• reemplazar con nueva key'
                : (provider === 'openrouter' ? 'sk-or-v1-…' : 'AIza…')}
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.label}>Modelo</label>
            <GlassInput
              value={model}
              onChange={setModel}
              placeholder={provider === 'openrouter'
                ? 'anthropic/claude-3.5-sonnet'
                : 'gemini-2.0-flash-exp'}
            />
          </div>
        </>
      )}

      <SaveBar dirty={dirty} saving={saving} onSave={save} />
    </Section>
  );
}

// ─── Telegram bot (editable) ─────────────────────────────────────────────────

function TelegramSection({ info }: { info: SetupInfo }) {
  const [enabled, setEnabled]   = useState(info.telegram.enabled);
  const [token, setToken]       = useState('');
  const [users, setUsers]       = useState(info.telegram.allowedUserIds.join(', '));
  const [saving, setSaving]     = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const dirty =
    enabled !== info.telegram.enabled
    || token.trim().length > 0
    || users !== info.telegram.allowedUserIds.join(', ');

  async function save() {
    setSaving(true);
    try {
      const updates: Record<string, string> = {
        ALLOWED_TELEGRAM_USERS: users.split(',').map(s => s.trim()).filter(Boolean).join(','),
      };
      if (!enabled) {
        updates.TELEGRAM_BOT_TOKEN = '';
      } else if (token.trim()) {
        updates.TELEGRAM_BOT_TOKEN = token.trim();
      } else if (!info.telegram.hasToken) {
        toast('Necesitás un bot token para activar Telegram', 'error');
        setSaving(false);
        return;
      }
      const result = await api.setupPatchEnv(updates);
      if (result.errors.length > 0) {
        toast(`Error: ${result.errors[0]!.message}`, 'error');
        return;
      }
      await applyRestarts(result.restartRequired);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      setToken('');
      toast('Telegram actualizado', 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Telegram bot" subtitle="Replica el chat AI a tu teléfono. El cambio reinicia el bot.">
      <div className={styles.formField}>
        <label className={styles.label}>Estado</label>
        <SegmentedControl
          value={enabled ? 'on' : 'off'}
          onChange={v => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: 'Desactivado' },
            { value: 'on',  label: 'Activado' },
          ]}
        />
      </div>

      {enabled && (
        <>
          <div className={styles.formField}>
            <label className={styles.label}>
              Bot token
              {info.telegram.hasToken && (
                <span className={styles.labelHint}>configurado — dejá vacío para mantener</span>
              )}
            </label>
            <GlassInput
              value={token}
              onChange={setToken}
              placeholder={info.telegram.hasToken ? '•••• reemplazar con nuevo token' : '123456:ABC-DEF…'}
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.label}>
              User IDs autorizados
              <span className={styles.labelHint}>vacío = cualquiera</span>
            </label>
            <GlassInput
              value={users}
              onChange={setUsers}
              placeholder="123456789, 987654321"
            />
          </div>
        </>
      )}

      <SaveBar dirty={dirty} saving={saving} onSave={save} />
    </Section>
  );
}

// ─── Service passwords (editable) ────────────────────────────────────────────

function ServicePasswordsSection({ info }: { info: SetupInfo }) {
  return (
    <Section
      title="Contraseñas de servicios"
      subtitle="Solo se guardan si escribís un valor nuevo. El container correspondiente se reinicia."
    >
      <PasswordRow
        service="qbittorrent"
        label="qBittorrent"
        envKey="QBIT_PASSWORD"
        configured={info.services.qbittorrent.hasPassword ?? false}
      />
      <PasswordRow
        service="pyload"
        label="PyLoad"
        envKey="PYLOAD_PASSWORD"
        configured={info.services.pyload.hasPassword ?? false}
      />
      <p className={styles.hintBox}>
        El password de Jellyfin admin se cambia desde la propia UI de Jellyfin
        (esto se va a integrar acá en la próxima iteración).
      </p>
    </Section>
  );
}

function PasswordRow({ service, label, envKey, configured }: {
  service: string;
  label:   string;
  envKey:  string;
  configured: boolean;
}) {
  const [value, setValue] = useState('');
  const [show, setShow]   = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const tooShort = value.length > 0 && value.length < 8;

  async function save() {
    if (tooShort) return;
    setSaving(true);
    try {
      const result = await api.setupPatchEnv({ [envKey]: value });
      if (result.errors.length > 0) {
        toast(`Error: ${result.errors[0]!.message}`, 'error');
        return;
      }
      await applyRestarts(result.restartRequired);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      setValue('');
      toast(`Contraseña de ${label} actualizada`, 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.formField}>
      <label className={styles.label}>
        {label}
        {configured
          ? <span className={styles.labelHint}>configurada — dejá vacío para mantener</span>
          : <span className={styles.labelWarn}>sin configurar</span>}
      </label>
      <div className={styles.passwordRow}>
        <div className={styles.passwordInput}>
          <GlassInput
            value={show ? value : '•'.repeat(value.length)}
            onChange={v => {
              if (show) setValue(v);
              else {
                if (v.length > value.length) setValue(value + v.slice(value.length));
                else setValue(value.slice(0, v.length));
              }
            }}
            placeholder="Mínimo 8 caracteres"
          />
          <button
            type="button"
            className={styles.eyeBtn}
            onClick={() => setShow(s => !s)}
            aria-label={show ? 'Ocultar' : 'Mostrar'}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <GlassButton
          variant="primary"
          size="sm"
          onClick={save}
          disabled={value.length === 0 || tooShort || saving}
        >
          {saving ? <RotateCw size={14} className={styles.spin} /> : <Save size={14} />}
          Guardar
        </GlassButton>
      </div>
      {tooShort && <span className={styles.errorText}>Mínimo 8 caracteres.</span>}
      <span className={styles.hint}>service: <code>{service}</code> · env: <code>{envKey}</code></span>
    </div>
  );
}

// ─── Services live status (read-only) ────────────────────────────────────────

function ServicesLiveSection({ info }: { info: SetupInfo }) {
  return (
    <Section title="Servicios" subtitle="Click en cualquiera para abrir su UI nativa en el navegador.">
      <ServiceUrlRow name="Jellyfin"     creds={info.services.jellyfin} />
      <ServiceUrlRow name="qBittorrent"  creds={info.services.qbittorrent} />
      <ServiceUrlRow name="PyLoad"       creds={info.services.pyload} />
      <ServiceUrlRow name="Sonarr"       creds={info.services.sonarr} />
      <ServiceUrlRow name="Radarr"       creds={info.services.radarr} />
      <ServiceUrlRow name="Prowlarr"     creds={info.services.prowlarr} />
      <ServiceUrlRow name="FlareSolverr" creds={info.services.flaresolverr} />
      {info.services.bazarr.enabled && (
        <ServiceUrlRow name="Bazarr" creds={info.services.bazarr} />
      )}
    </Section>
  );
}

function ServiceUrlRow({ name, creds }: { name: string; creds: ServiceCreds }) {
  return (
    <div className={styles.serviceRow}>
      <div className={styles.serviceMain}>
        <span className={styles.serviceName}>{name}</span>
        {creds.user && <span className={styles.serviceUser}>usuario: <strong>{creds.user}</strong></span>}
        <code className={styles.serviceUrl}>{creds.url.replace(/^https?:\/\//, '')}</code>
      </div>
      <div className={styles.serviceBadges}>
        {creds.hasApiKey   && <Badge tone="ok">API key</Badge>}
        {creds.hasPassword && <Badge tone="ok">password</Badge>}
        {creds.hasApiKey === false   && <Badge tone="warn">sin key</Badge>}
        {creds.hasPassword === false && <Badge tone="warn">sin pwd</Badge>}
      </div>
      <button
        type="button"
        className={styles.iconBtn}
        onClick={() => void openExternal(creds.url)}
        title="Abrir en navegador"
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

// ─── System info (read-only) ─────────────────────────────────────────────────

function SystemSection({ info }: { info: SetupInfo }) {
  return (
    <Section title="Sistema">
      <Row k="Zona horaria"  v={info.system.timezone} />
      <Row k="UID / GID"     v={`${info.system.puid} : ${info.system.pgid}`} mono />
      <Row k="Películas"     v={info.paths.movies} mono />
      <Row k="Series"        v={info.paths.tv}     mono />
      <Row k="Anime"         v={info.paths.anime}  mono />
      <Row k="Música"        v={info.paths.music}  mono />
      <span className={styles.hintBox}>
        Cambiar paths o uid/gid requiere recrear los containers. Próxima iteración.
      </span>
    </Section>
  );
}

// ─── Stack lifecycle (actions) ───────────────────────────────────────────────

function StackLifecycleSection() {
  const [busy, setBusy] = useState<null | 'restart' | 'stop' | 'start'>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  async function run(kind: 'restart' | 'stop' | 'start') {
    const labels = { restart: 'Reiniciar', stop: 'Detener', start: 'Iniciar' };
    const ok = await confirmDialog(
      `Esto va a ${labels[kind].toLowerCase()} todos los containers del stack. ¿Continuar?`,
      `${labels[kind]} stack`,
    );
    if (!ok) return;
    setBusy(kind);
    try {
      if (kind === 'restart') await api.setupStackRestart();
      if (kind === 'stop')    await api.setupStackStop();
      if (kind === 'start')   await api.setupStackStart();
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(`${labels[kind]} ejecutado`, 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Operaciones del stack" subtitle="Acciones globales sobre todos los containers (docker compose).">
      <div className={styles.actionsRow}>
        <GlassButton variant="secondary" onClick={() => run('start')} disabled={busy !== null}>
          {busy === 'start' ? <RotateCw size={14} className={styles.spin} /> : <Play size={14} />}
          Iniciar todo
        </GlassButton>
        <GlassButton variant="secondary" onClick={() => run('restart')} disabled={busy !== null}>
          {busy === 'restart' ? <RotateCw size={14} className={styles.spin} /> : <RotateCw size={14} />}
          Reiniciar todo
        </GlassButton>
        <GlassButton variant="secondary" onClick={() => run('stop')} disabled={busy !== null}>
          {busy === 'stop' ? <RotateCw size={14} className={styles.spin} /> : <Power size={14} />}
          Detener todo
        </GlassButton>
      </div>
    </Section>
  );
}

// ─── Advanced (re-run wizard, open .env, etc.) ───────────────────────────────

function AdvancedSection({ info }: { info: SetupInfo }) {
  const { toast } = useToast();

  async function rerunWizard() {
    const ok = await confirmDialog(
      'Esto borra el estado del wizard pero NO toca el stack desplegado. La próxima vez que abras la app vas a ver el wizard de nuevo. ¿Continuar?',
      'Re-correr wizard',
    );
    if (!ok) return;
    try {
      await resetAppState();
      toast('Estado borrado. Reiniciá la app para ver el wizard.', 'info');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  return (
    <Section title="Avanzado">
      <div className={styles.actionsRow}>
        {info.stack.workDir && (
          <GlassButton
            variant="secondary"
            onClick={() => info.stack.workDir && void openExternal(`file://${info.stack.workDir}`)}
          >
            <FolderOpen size={14} />
            Abrir carpeta del stack
          </GlassButton>
        )}
        <GlassButton variant="secondary" onClick={rerunWizard}>
          <Trash2 size={14} />
          Re-correr wizard
        </GlassButton>
      </div>
      <span className={styles.hintBox}>
        <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        Re-correr wizard solo limpia <code>state.json</code>. Los containers Docker
        siguen corriendo — para empezar de cero hace falta también <code>docker compose down -v</code>
        en la carpeta del stack.
      </span>
    </Section>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  Helpers
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/**
 * Apply the restart targets returned by PATCH /env. "sidecar" goes through
 * the Tauri command (since the desktop binary spawns it); everything else
 * goes through `docker compose restart`.
 */
async function applyRestarts(restartRequired: string[]): Promise<void> {
  const dockerSvcs = restartRequired.filter(s => s !== 'sidecar');
  const needsSidecar = restartRequired.includes('sidecar');

  if (dockerSvcs.length > 0) {
    await api.setupRestartServices(dockerSvcs);
  }
  if (needsSidecar) {
    await restartSidecar();
    await reloadRuntimeConfig();
  }
}

function Section({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <GlassCard className={styles.section}>
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {subtitle && <p className={styles.sectionSubtitle}>{subtitle}</p>}
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </GlassCard>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className={styles.row}>
      <dt className={styles.dt}>{k}</dt>
      <dd className={[styles.dd, mono && styles.mono].filter(Boolean).join(' ')}>{v}</dd>
    </div>
  );
}

function SaveBar({ dirty, saving, onSave }: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className={styles.saveBar}>
      {dirty && <span className={styles.dirty}>Cambios sin guardar</span>}
      <GlassButton variant="primary" size="sm" onClick={onSave} disabled={!dirty || saving}>
        {saving ? <RotateCw size={14} className={styles.spin} /> : <Save size={14} />}
        Guardar y reiniciar
      </GlassButton>
    </div>
  );
}
