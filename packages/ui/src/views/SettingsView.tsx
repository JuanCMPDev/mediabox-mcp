import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink, RefreshCw, FolderOpen, Eye, EyeOff,
  Save, RotateCw, Power, Play, AlertTriangle, Trash2, ScrollText, Download, KeyRound,
} from 'lucide-react';
import { LogDrawer }    from '@/components/log-drawer/LogDrawer';
import { UpdateDrawer } from '@/components/update-drawer/UpdateDrawer';

import { GlassCard }   from '@/components/atoms/GlassCard';
import { GlassButton } from '@/components/atoms/GlassButton';
import { GlassInput }  from '@/components/atoms/GlassInput';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import { Skeleton }    from '@/components/atoms/Skeleton';

import { api }              from '@/lib/api';
import { useSetupInfo }     from '@/lib/queries';
import { useToast }         from '@/lib/toast';
import {
  openExternal, openPath, confirmDialog, resetAppState, restartSidecar,
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
          <h1 className={styles.title}>Settings</h1>
          <p className={styles.subtitle}>
            Changes affect the deployed stack. Affected containers restart automatically when you save.
          </p>
        </div>
        <GlassButton variant="secondary" size="sm" onClick={() => void refetch()}>
          <RefreshCw size={14} />
          Refresh
        </GlassButton>
      </header>

      {isLoading && <SettingsSkeleton />}

      {info && (
        <>
          <StackOverview info={info} />
          <AIProviderSection info={info} />
          <TelegramSection info={info} />
          <ServicePasswordsSection info={info} />
          <JellyfinPasswordSection info={info} />
          <ServiceApiKeysSection info={info} />
          <ServicesLiveSection info={info} />
          <SystemSection info={info} />
          <UpdatesSection />
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
    <Section title="Stack">
      <Row k="Location"    v={info.stack.workDir ?? '—'} mono />
      <Row k="Mode"        v={info.stack.deploymentMode} />
      <Row k="Image tag"   v={info.stack.imageTag} mono />
      {info.stack.baseDomain && <Row k="Base domain" v={info.stack.baseDomain} />}
      <Row k="App version" v={info.app.version} mono />
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
      toast('AI provider updated', 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="AI assistant" subtitle="Saving restarts the in-app chat and Telegram bot.">
      <div className={styles.formField}>
        <label className={styles.label}>Provider</label>
        <SegmentedControl
          value={provider}
          onChange={v => setProvider(v as typeof provider)}
          options={[
            { value: 'none',       label: 'No AI' },
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
                <span className={styles.labelHint}>set — leave blank to keep</span>
              )}
            </label>
            <GlassInput
              type="password"
              value={apiKey}
              onChange={setApiKey}
              placeholder={info.ai.hasKey && info.ai.provider === provider
                ? '•••• replace with new key'
                : (provider === 'openrouter' ? 'sk-or-v1-…' : 'AIza…')}
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.label}>Model</label>
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
        toast('A bot token is required to enable Telegram', 'error');
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
      toast('Telegram updated', 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Telegram bot" subtitle="Mirrors the AI chat to your phone. Saving restarts the bot.">
      <div className={styles.formField}>
        <label className={styles.label}>Status</label>
        <SegmentedControl
          value={enabled ? 'on' : 'off'}
          onChange={v => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: 'Disabled' },
            { value: 'on',  label: 'Enabled' },
          ]}
        />
      </div>

      {enabled && (
        <>
          <div className={styles.formField}>
            <label className={styles.label}>
              Bot token
              {info.telegram.hasToken && (
                <span className={styles.labelHint}>set — leave blank to keep</span>
              )}
            </label>
            <GlassInput
              type="password"
              value={token}
              onChange={setToken}
              placeholder={info.telegram.hasToken ? '•••• replace with new token' : '123456:ABC-DEF…'}
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.label}>
              Allowed user IDs
              <span className={styles.labelHint}>blank = anyone</span>
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
    <>
      <Section
        title="qBittorrent password"
        subtitle="Username is always admin. Saving rotates the password and restarts qBittorrent."
      >
        <PasswordRow
          service="qbittorrent"
          label="qBittorrent"
          envKey="QBIT_PASSWORD"
          configured={info.services.qbittorrent.hasPassword ?? false}
        />
      </Section>

      <Section
        title="PyLoad credentials"
        subtitle="PyLoad's image always starts with default credentials. Rotate them from PyLoad's web UI if needed."
      >
        <Row k="Username" v="pyload" mono />
        <Row k="Password" v="pyload" mono />
      </Section>
    </>
  );
}

function PasswordRow({ label, envKey, configured }: {
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
      toast(`${label} password updated`, 'success');
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
          ? <span className={styles.labelHint}>set — leave blank to keep</span>
          : <span className={styles.labelWarn}>not set</span>}
      </label>
      <div className={styles.passwordRow}>
        <div className={styles.passwordInput}>
          <GlassInput
            type={show ? 'text' : 'password'}
            value={value}
            onChange={setValue}
            placeholder="Min. 8 characters"
            iconRight={<EyeToggleButton show={show} onToggle={() => setShow(s => !s)} />}
          />
        </div>
        <GlassButton
          variant="primary"
          size="sm"
          onClick={save}
          disabled={value.length === 0 || tooShort || saving}
        >
          {saving ? <RotateCw size={14} className={styles.spin} /> : <Save size={14} />}
          Save
        </GlassButton>
      </div>
      {tooShort && <span className={styles.errorText}>At least 8 characters.</span>}
    </div>
  );
}

// ─── Jellyfin admin password ──────────────────────────────────────────────────

function JellyfinPasswordSection({ info }: { info: SetupInfo }) {
  const [current,   setCurrent]   = useState('');
  const [next,      setNext]      = useState('');
  const [showCur,   setShowCur]   = useState(false);
  const [showNext,  setShowNext]  = useState(false);
  const [saving,    setSaving]    = useState(false);
  const { toast } = useToast();

  const adminUser   = info.services.jellyfin.user;
  const nextTooShort = next.length > 0 && next.length < 8;
  const canSave     = current.length > 0 && next.length >= 8 && !saving;

  if (!adminUser) {
    return (
      <Section title="Jellyfin admin password">
        <span className={styles.hintBox}>
          Admin user not set. Re-run the wizard to configure it.
        </span>
      </Section>
    );
  }

  async function save() {
    setSaving(true);
    try {
      await api.setupJellyfinPassword(current, next);
      toast('Jellyfin password updated', 'success');
      setCurrent('');
      setNext('');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Jellyfin admin password"
      subtitle={`User: ${adminUser}. The change is applied directly in Jellyfin.`}
    >
      <div className={styles.formField}>
        <label className={styles.label}>Current password</label>
        <GlassInput
          type={showCur ? 'text' : 'password'}
          value={current}
          onChange={setCurrent}
          placeholder="Current password"
          iconRight={<EyeToggleButton show={showCur} onToggle={() => setShowCur(s => !s)} />}
        />
      </div>

      <div className={styles.formField}>
        <label className={styles.label}>New password</label>
        <GlassInput
          type={showNext ? 'text' : 'password'}
          value={next}
          onChange={setNext}
          placeholder="Min. 8 characters"
          iconRight={<EyeToggleButton show={showNext} onToggle={() => setShowNext(s => !s)} />}
        />
        {nextTooShort && <span className={styles.errorText}>At least 8 characters.</span>}
      </div>

      <div className={styles.saveBar}>
        <GlassButton variant="primary" size="sm" onClick={save} disabled={!canSave}>
          {saving ? <RotateCw size={14} className={styles.spin} /> : <Save size={14} />}
          Change password
        </GlassButton>
      </div>
    </Section>
  );
}

// ─── *arr API key rotation ───────────────────────────────────────────────────

function ServiceApiKeysSection({ info }: { info: SetupInfo }) {
  return (
    <Section
      title="*arr API keys"
      subtitle="Generate a fresh API key for Sonarr, Radarr, or Prowlarr."
    >
      <ArrApiKeyRow service="sonarr"   label="Sonarr"   hasKey={info.services.sonarr.hasApiKey   ?? false} />
      <ArrApiKeyRow service="radarr"   label="Radarr"   hasKey={info.services.radarr.hasApiKey   ?? false} />
      <ArrApiKeyRow service="prowlarr" label="Prowlarr" hasKey={info.services.prowlarr.hasApiKey ?? false} />
    </Section>
  );
}

interface ArrApiKeyRowProps {
  service: 'sonarr' | 'radarr' | 'prowlarr';
  label:   string;
  hasKey:  boolean;
}

function ArrApiKeyRow({ service, label, hasKey }: ArrApiKeyRowProps) {
  const [busy, setBusy] = useState(false);
  const { toast }       = useToast();
  const qc              = useQueryClient();

  async function regenerate() {
    const ok = await confirmDialog(
      `${label} will be briefly restarted while we rotate its API key. Anything still using the old key will need to be reconfigured. Continue?`,
      `Rotate ${label} API key`,
    );
    if (!ok) return;

    setBusy(true);
    try {
      const result = await api.setupRegenerateApiKey(service);
      if (result.restartRequired.includes('sidecar')) {
        await restartSidecar();
        await reloadRuntimeConfig();
      }
      void qc.invalidateQueries({ queryKey: ['setup-info'] });
      void qc.invalidateQueries({ queryKey: ['services'] });
      toast(`${label} API key rotated`, 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.serviceRow}>
      <div className={styles.serviceMain}>
        <span className={styles.serviceName}>{label}</span>
      </div>
      <div className={styles.serviceBadges}>
        {hasKey
          ? <Badge tone="ok">set</Badge>
          : <Badge tone="warn">not set</Badge>}
      </div>
      <GlassButton variant="secondary" size="sm" onClick={regenerate} disabled={busy}>
        {busy ? <RotateCw size={13} className={styles.spin} /> : <KeyRound size={13} />}
        Rotate
      </GlassButton>
    </div>
  );
}

// ─── Services live status (read-only) ────────────────────────────────────────

// Maps display name → docker-compose service name used by the log endpoint.
const SERVICE_ID: Record<string, string> = {
  Jellyfin:     'jellyfin',
  qBittorrent:  'qbittorrent',
  PyLoad:       'pyload',
  Sonarr:       'sonarr',
  Radarr:       'radarr',
  Prowlarr:     'prowlarr',
  FlareSolverr: 'flaresolverr',
  Bazarr:       'bazarr',
};

function ServicesLiveSection({ info }: { info: SetupInfo }) {
  const [logService, setLogService] = useState<{ id: string; name: string } | null>(null);

  return (
    <Section title="Services" subtitle="Click any to open its web UI in your browser.">
      <ServiceUrlRow name="Jellyfin"     creds={info.services.jellyfin}     onOpenLogs={setLogService} />
      <ServiceUrlRow name="qBittorrent"  creds={info.services.qbittorrent}  onOpenLogs={setLogService} />
      <ServiceUrlRow name="PyLoad"       creds={info.services.pyload}       onOpenLogs={setLogService} />
      <ServiceUrlRow name="Sonarr"       creds={info.services.sonarr}       onOpenLogs={setLogService} />
      <ServiceUrlRow name="Radarr"       creds={info.services.radarr}       onOpenLogs={setLogService} />
      <ServiceUrlRow name="Prowlarr"     creds={info.services.prowlarr}     onOpenLogs={setLogService} />
      <ServiceUrlRow name="FlareSolverr" creds={info.services.flaresolverr} onOpenLogs={setLogService} />
      {info.services.bazarr.enabled && (
        <ServiceUrlRow name="Bazarr"     creds={info.services.bazarr}       onOpenLogs={setLogService} />
      )}

      {logService && (
        <LogDrawer
          service={logService.id}
          displayName={logService.name}
          onClose={() => setLogService(null)}
        />
      )}
    </Section>
  );
}

interface ServiceUrlRowProps {
  name:       string;
  creds:      ServiceCreds;
  onOpenLogs: (s: { id: string; name: string }) => void;
}

function ServiceUrlRow({ name, creds, onOpenLogs }: ServiceUrlRowProps) {
  const serviceId = SERVICE_ID[name];
  return (
    <div className={styles.serviceRow}>
      <div className={styles.serviceMain}>
        <span className={styles.serviceName}>{name}</span>
        {creds.user && <span className={styles.serviceUser}>user: <strong>{creds.user}</strong></span>}
        <code className={styles.serviceUrl}>{creds.url.replace(/^https?:\/\//, '')}</code>
      </div>
      <div className={styles.serviceBadges}>
        {creds.hasApiKey   && <Badge tone="ok">API key</Badge>}
        {creds.hasPassword && <Badge tone="ok">password</Badge>}
        {creds.hasApiKey === false   && <Badge tone="warn">no key</Badge>}
        {creds.hasPassword === false && <Badge tone="warn">no password</Badge>}
      </div>
      {serviceId && (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => onOpenLogs({ id: serviceId, name })}
          title={`View ${name} logs`}
        >
          <ScrollText size={14} />
        </button>
      )}
      <button
        type="button"
        className={styles.iconBtn}
        onClick={() => void openExternal(creds.url)}
        title="Open in browser"
      >
        <ExternalLink size={14} />
      </button>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

/** Inline eye-toggle button rendered inside a GlassInput's `iconRight` slot. */
function EyeToggleButton({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={show ? 'Hide password' : 'Show password'}
      style={{
        background: 'transparent',
        border: 'none',
        color: 'inherit',
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        lineHeight: 0,
      }}
    >
      {show ? <EyeOff size={14} /> : <Eye size={14} />}
    </button>
  );
}

// ─── System info (read-only) ─────────────────────────────────────────────────

function SystemSection({ info }: { info: SetupInfo }) {
  return (
    <Section title="System">
      <Row k="Timezone" v={info.system.timezone} />
      <Row k="UID / GID" v={`${info.system.puid} : ${info.system.pgid}`} mono />
      <Row k="Movies" v={info.paths.movies} mono />
      <Row k="TV"     v={info.paths.tv}     mono />
      <Row k="Anime"  v={info.paths.anime}  mono />
      <Row k="Music"  v={info.paths.music}  mono />
      <span className={styles.hintBox}>
        Editing paths or UID/GID requires recreating the containers. Coming soon.
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
    const labels: Record<typeof kind, { verb: string; toast: string; title: string }> = {
      restart: { verb: 'restart', toast: 'Stack restarted', title: 'Restart stack' },
      stop:    { verb: 'stop',    toast: 'Stack stopped',   title: 'Stop stack' },
      start:   { verb: 'start',   toast: 'Stack started',   title: 'Start stack' },
    };
    const ok = await confirmDialog(
      `This will ${labels[kind].verb} every container in the stack. Continue?`,
      labels[kind].title,
    );
    if (!ok) return;
    setBusy(kind);
    try {
      if (kind === 'restart') await api.setupStackRestart();
      if (kind === 'stop')    await api.setupStackStop();
      if (kind === 'start')   await api.setupStackStart();
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(labels[kind].toast, 'success');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Stack lifecycle" subtitle="Global actions on every container.">
      <div className={styles.actionsRow}>
        <GlassButton variant="secondary" onClick={() => run('start')} disabled={busy !== null}>
          {busy === 'start' ? <RotateCw size={14} className={styles.spin} /> : <Play size={14} />}
          Start all
        </GlassButton>
        <GlassButton variant="secondary" onClick={() => run('restart')} disabled={busy !== null}>
          {busy === 'restart' ? <RotateCw size={14} className={styles.spin} /> : <RotateCw size={14} />}
          Restart all
        </GlassButton>
        <GlassButton variant="secondary" onClick={() => run('stop')} disabled={busy !== null}>
          {busy === 'stop' ? <RotateCw size={14} className={styles.spin} /> : <Power size={14} />}
          Stop all
        </GlassButton>
      </div>
    </Section>
  );
}

// ─── Update checker ──────────────────────────────────────────────────────────

function UpdatesSection() {
  const [showDrawer, setShowDrawer] = useState(false);
  const qc = useQueryClient();

  return (
    <Section
      title="Updates"
      subtitle="Pull the latest Docker images and restart only what changed."
    >
      <div className={styles.actionsRow}>
        <GlassButton variant="secondary" onClick={() => setShowDrawer(true)}>
          <Download size={14} />
          Check for updates
        </GlassButton>
      </div>
      {showDrawer && (
        <UpdateDrawer
          onClose={() => setShowDrawer(false)}
          onApplied={() => {
            void qc.invalidateQueries({ queryKey: ['services'] });
            setShowDrawer(false);
          }}
        />
      )}
    </Section>
  );
}

// ─── Advanced (re-run wizard, open .env, etc.) ───────────────────────────────

function AdvancedSection({ info }: { info: SetupInfo }) {
  const { toast } = useToast();

  async function openStackFolder() {
    if (!info.stack.workDir) return;
    try {
      await openPath(info.stack.workDir);
    } catch (err) {
      toast(`Couldn't open stack folder: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async function rerunWizard() {
    const ok = await confirmDialog(
      'This clears the wizard state but does NOT touch the deployed stack. Next launch will run the wizard again. Continue?',
      'Re-run wizard',
    );
    if (!ok) return;
    try {
      await resetAppState();
      toast('Wizard state cleared. Restart the app to see the wizard.', 'info');
    } catch (err) {
      toast(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  return (
    <Section title="Advanced">
      <div className={styles.actionsRow}>
        {info.stack.workDir && (
          <GlassButton variant="secondary" onClick={() => void openStackFolder()}>
            <FolderOpen size={14} />
            Open stack folder
          </GlassButton>
        )}
        <GlassButton variant="secondary" onClick={rerunWizard}>
          <Trash2 size={14} />
          Re-run wizard
        </GlassButton>
      </div>
      <span className={styles.hintBox}>
        <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        Re-running the wizard only clears <code>state.json</code>. Docker containers keep running —
        to start completely fresh, also run <code>docker compose down -v</code> in the stack folder.
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
