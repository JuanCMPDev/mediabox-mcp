import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation, Trans } from 'react-i18next';
import {
  ExternalLink, RefreshCw, FolderOpen, Folder, Eye, EyeOff,
  Save, RotateCw, Power, Play, AlertTriangle, Trash2, ScrollText, Download, KeyRound,
  Archive, Upload,
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
import { useAppPreferences, type Locale, type RefreshProfile } from '@/lib/use-app-preferences';
import {
  openExternal, openPath, pickDirectory, confirmDialog, resetAppState, restartSidecar,
  exportConfigToZip, importConfigFromZip,
} from '@/lib/tauri-bridge';
import { reloadRuntimeConfig } from '@/lib/runtime-config';
import type { SetupInfo, ServiceCreds } from '@mediabox/contracts';

import styles from './SettingsView.module.css';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  Top-level view
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export function SettingsView() {
  const { data: info, isLoading, refetch } = useSetupInfo();
  const { t } = useTranslation('settings');

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('title')}</h1>
          <p className={styles.subtitle}>
            {t('subtitle')}
          </p>
        </div>
        <GlassButton variant="secondary" size="sm" onClick={() => void refetch()}>
          <RefreshCw size={14} />
          {t('refresh')}
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
          <MediaPathsSection info={info} />
          <UpdatesSection />
          <PreferencesSection />
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
  const { t } = useTranslation('settings');
  return (
    <Section title={t('stack.title')}>
      <Row k={t('stack.location')}    v={info.stack.workDir ?? '—'} mono />
      <Row k={t('stack.mode')}        v={info.stack.deploymentMode} />
      <Row k={t('stack.imageTag')}   v={info.stack.imageTag} mono />
      {info.stack.baseDomain && <Row k={t('stack.baseDomain')} v={info.stack.baseDomain} />}
      <Row k={t('stack.appVersion')} v={info.app.version} mono />
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
  const { t } = useTranslation('settings');

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
        toast(t('error', { message: result.errors[0]!.message }), 'error');
        return;
      }
      // Restart docker containers + sidecar (for chat to pick up new key)
      await applyRestarts(result.restartRequired);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      setApiKey('');
      toast(t('ai.updated'), 'success');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title={t('ai.title')} subtitle={t('ai.subtitle')}>
      <div className={styles.formField}>
        <label className={styles.label}>{t('ai.provider')}</label>
        <SegmentedControl
          value={provider}
          onChange={v => setProvider(v as typeof provider)}
          options={[
            { value: 'none',       label: t('ai.noAi') },
            { value: 'openrouter', label: t('ai.openRouter') },
            { value: 'google',     label: t('ai.googleAi') },
          ]}
        />
      </div>

      {provider !== 'none' && (
        <>
          <div className={styles.formField}>
            <label className={styles.label}>
              {t('ai.apiKey')}
              {info.ai.hasKey && info.ai.provider === provider && (
                <span className={styles.labelHint}>{t('ai.setLeaveBlank')}</span>
              )}
            </label>
            <GlassInput
              type="password"
              value={apiKey}
              onChange={setApiKey}
              placeholder={info.ai.hasKey && info.ai.provider === provider
                ? t('ai.replaceWithNew')
                : (provider === 'openrouter' ? 'sk-or-v1-…' : 'AIza…')}
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.label}>{t('ai.model')}</label>
            <GlassInput
              value={model}
              onChange={setModel}
              placeholder={provider === 'openrouter'
                ? 'openai/gpt-4o'
                : 'gemini-2.5-flash'}
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
  const { t } = useTranslation('settings');

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
        toast(t('telegram.tokenRequired'), 'error');
        setSaving(false);
        return;
      }
      const result = await api.setupPatchEnv(updates);
      if (result.errors.length > 0) {
        toast(t('error', { message: result.errors[0]!.message }), 'error');
        return;
      }
      await applyRestarts(result.restartRequired);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      setToken('');
      toast(t('telegram.updated'), 'success');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title={t('telegram.title')} subtitle={t('telegram.subtitle')}>
      <div className={styles.formField}>
        <label className={styles.label}>{t('telegram.status')}</label>
        <SegmentedControl
          value={enabled ? 'on' : 'off'}
          onChange={v => setEnabled(v === 'on')}
          options={[
            { value: 'off', label: t('telegram.disabled') },
            { value: 'on',  label: t('telegram.enabled') },
          ]}
        />
      </div>

      {enabled && (
        <>
          <div className={styles.formField}>
            <label className={styles.label}>
              {t('telegram.botToken')}
              {info.telegram.hasToken && (
                <span className={styles.labelHint}>{t('ai.setLeaveBlank')}</span>
              )}
            </label>
            <GlassInput
              type="password"
              value={token}
              onChange={setToken}
              placeholder={info.telegram.hasToken ? t('telegram.replaceToken') : '123456:ABC-DEF…'}
            />
          </div>

          <div className={styles.formField}>
            <label className={styles.label}>
              {t('telegram.allowedUsers')}
              <span className={styles.labelHint}>{t('telegram.blankAnyone')}</span>
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
  const { t } = useTranslation('settings');
  return (
    <>
      <Section
        title={t('passwords.qbitTitle')}
        subtitle={t('passwords.qbitSubtitle')}
      >
        <PasswordRow
          service="qbittorrent"
          label={t('passwords.qbitLabel')}
          envKey="QBIT_PASSWORD"
          configured={info.services.qbittorrent.hasPassword ?? false}
        />
      </Section>

      <Section
        title={t('passwords.pyloadTitle')}
        subtitle={t('passwords.pyloadSubtitle')}
      >
        <Row k={t('passwords.username')} v="pyload" mono />
        <Row k={t('passwords.password')} v="pyload" mono />
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
  const { t } = useTranslation('settings');

  const tooShort = value.length > 0 && value.length < 8;

  async function save() {
    if (tooShort) return;
    setSaving(true);
    try {
      const result = await api.setupPatchEnv({ [envKey]: value });
      if (result.errors.length > 0) {
        toast(t('error', { message: result.errors[0]!.message }), 'error');
        return;
      }
      await applyRestarts(result.restartRequired);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      setValue('');
      toast(t('passwords.updated', { label }), 'success');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.formField}>
      <label className={styles.label}>
        {label}
        {configured
          ? <span className={styles.labelHint}>{t('ai.setLeaveBlank')}</span>
          : <span className={styles.labelWarn}>{t('passwords.notSet')}</span>}
      </label>
      <div className={styles.passwordRow}>
        <div className={styles.passwordInput}>
          <GlassInput
            type={show ? 'text' : 'password'}
            value={value}
            onChange={setValue}
            placeholder={t('passwords.min8')}
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
          {t('passwords.save')}
        </GlassButton>
      </div>
      {tooShort && <span className={styles.errorText}>{t('passwords.atLeast8')}</span>}
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
  const { t } = useTranslation('settings');

  const adminUser   = info.services.jellyfin.user;
  const nextTooShort = next.length > 0 && next.length < 8;
  const canSave     = current.length > 0 && next.length >= 8 && !saving;

  if (!adminUser) {
    return (
      <Section title={t('passwords.jellyfinTitle')}>
        <span className={styles.hintBox}>
          {t('passwords.jellyfinNotSet')}
        </span>
      </Section>
    );
  }

  async function save() {
    setSaving(true);
    try {
      await api.setupJellyfinPassword(current, next);
      toast(t('passwords.jellyfinUpdated'), 'success');
      setCurrent('');
      setNext('');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title={t('passwords.jellyfinTitle')}
      subtitle={t('passwords.jellyfinSubtitle', { user: adminUser })}
    >
      <div className={styles.formField}>
        <label className={styles.label}>{t('passwords.currentPassword')}</label>
        <GlassInput
          type={showCur ? 'text' : 'password'}
          value={current}
          onChange={setCurrent}
          placeholder={t('passwords.currentPassword')}
          iconRight={<EyeToggleButton show={showCur} onToggle={() => setShowCur(s => !s)} />}
        />
      </div>

      <div className={styles.formField}>
        <label className={styles.label}>{t('passwords.newPassword')}</label>
        <GlassInput
          type={showNext ? 'text' : 'password'}
          value={next}
          onChange={setNext}
          placeholder={t('passwords.min8')}
          iconRight={<EyeToggleButton show={showNext} onToggle={() => setShowNext(s => !s)} />}
        />
        {nextTooShort && <span className={styles.errorText}>{t('passwords.atLeast8')}</span>}
      </div>

      <div className={styles.saveBar}>
        <GlassButton variant="primary" size="sm" onClick={save} disabled={!canSave}>
          {saving ? <RotateCw size={14} className={styles.spin} /> : <Save size={14} />}
          {t('passwords.changePassword')}
        </GlassButton>
      </div>
    </Section>
  );
}

// ─── *arr API key rotation ───────────────────────────────────────────────────

function ServiceApiKeysSection({ info }: { info: SetupInfo }) {
  const { t } = useTranslation('settings');
  return (
    <Section
      title={t('apiKeys.title')}
      subtitle={t('apiKeys.subtitle')}
    >
      <ArrApiKeyRow service="sonarr"   label={t('apiKeys.sonarr')}   hasKey={info.services.sonarr.hasApiKey   ?? false} />
      <ArrApiKeyRow service="radarr"   label={t('apiKeys.radarr')}   hasKey={info.services.radarr.hasApiKey   ?? false} />
      <ArrApiKeyRow service="prowlarr" label={t('apiKeys.prowlarr')} hasKey={info.services.prowlarr.hasApiKey ?? false} />
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
  const { t }           = useTranslation('settings');

  async function regenerate() {
    const ok = await confirmDialog(
      t('apiKeys.confirmMessage', { label }),
      t('apiKeys.confirmTitle', { label }),
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
      toast(t('apiKeys.rotated', { label }), 'success');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
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
          ? <Badge tone="ok">{t('apiKeys.set')}</Badge>
          : <Badge tone="warn">{t('passwords.notSet')}</Badge>}
      </div>
      <GlassButton variant="secondary" size="sm" onClick={regenerate} disabled={busy}>
        {busy ? <RotateCw size={13} className={styles.spin} /> : <KeyRound size={13} />}
        {t('apiKeys.rotate')}
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
  const { t } = useTranslation('settings');

  return (
    <Section title={t('services.title')} subtitle={t('services.subtitle')}>
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
  const { t } = useTranslation('settings');
  return (
    <div className={styles.serviceRow}>
      <div className={styles.serviceMain}>
        <span className={styles.serviceName}>{name}</span>
        {creds.user && <span className={styles.serviceUser}>{t('services.user')}<strong>{creds.user}</strong></span>}
        <code className={styles.serviceUrl}>{creds.url.replace(/^https?:\/\//, '')}</code>
      </div>
      <div className={styles.serviceBadges}>
        {creds.hasApiKey   && <Badge tone="ok">{t('services.apiKey')}</Badge>}
        {creds.hasPassword && <Badge tone="ok">{t('services.password')}</Badge>}
        {creds.hasApiKey === false   && <Badge tone="warn">{t('services.noKey')}</Badge>}
        {creds.hasPassword === false && <Badge tone="warn">{t('services.noPassword')}</Badge>}
      </div>
      {serviceId && (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => onOpenLogs({ id: serviceId, name })}
          title={t('services.viewLogs', { name })}
        >
          <ScrollText size={14} />
        </button>
      )}
      <button
        type="button"
        className={styles.iconBtn}
        onClick={() => void openExternal(creds.url)}
        title={t('services.openBrowser')}
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
  const { t } = useTranslation('settings');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={show ? t('eyeToggle.hide') : t('eyeToggle.show')}
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
  const [tz,   setTz]   = useState(info.system.timezone);
  const [puid, setPuid] = useState(String(info.system.puid));
  const [pgid, setPgid] = useState(String(info.system.pgid));
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t } = useTranslation('settings');

  const dirty =
    tz   !== info.system.timezone
    || puid !== String(info.system.puid)
    || pgid !== String(info.system.pgid);

  const valid = tz.trim().length > 0 && /^\d+$/.test(puid) && /^\d+$/.test(pgid);

  async function save() {
    if (!dirty || !valid) return;
    const ok = await confirmDialog(
      t('system.confirmMessage'),
      t('system.confirmTitle'),
    );
    if (!ok) return;

    setSaving(true);
    try {
      const updates: Record<string, string> = {};
      if (tz   !== info.system.timezone)         updates.TZ   = tz.trim();
      if (puid !== String(info.system.puid))     updates.PUID = puid;
      if (pgid !== String(info.system.pgid))     updates.PGID = pgid;
      const result = await api.setupPatchEnv(updates);
      if (result.errors.length > 0) {
        toast(t('error', { message: result.errors[0]!.message }), 'error');
        return;
      }
      await applyEnvChanges(result);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('system.updated'), 'success');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title={t('system.title')} subtitle={t('system.subtitle')}>
      <div className={styles.formField}>
        <label className={styles.label}>{t('system.timezone')}</label>
        <GlassInput value={tz} onChange={setTz} placeholder="Europe/Madrid" />
        <span className={styles.hint}>
          <Trans t={t} i18nKey="system.ianaHint">IANA format (e.g. <code>Europe/Madrid</code>, <code>America/Argentina/Buenos_Aires</code>).</Trans>
        </span>
      </div>

      <div className={styles.formField}>
        <label className={styles.label}>{t('system.puidPgid')}</label>
        <div className={styles.passwordRow}>
          <div className={styles.passwordInput}>
            <GlassInput value={puid} onChange={setPuid} placeholder="1000" />
          </div>
          <div className={styles.passwordInput}>
            <GlassInput value={pgid} onChange={setPgid} placeholder="1000" />
          </div>
        </div>
        <span className={styles.hint}>
          <Trans t={t} i18nKey="system.idHint">User and group IDs LinuxServer containers run as. Run <code>id -u</code> and <code>id -g</code> on Linux to find yours; <code>1000:1000</code> works on Windows/macOS.</Trans>
        </span>
      </div>

      <SaveBar dirty={dirty && valid} saving={saving} onSave={save} />
    </Section>
  );
}

// ─── Media paths (editable) ───────────────────────────────────────────────────

function MediaPathsSection({ info }: { info: SetupInfo }) {
  const [movies, setMovies] = useState(info.paths.movies);
  const [tv,     setTv]     = useState(info.paths.tv);
  const [anime,  setAnime]  = useState(info.paths.anime);
  const [music,  setMusic]  = useState(info.paths.music);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t } = useTranslation('settings');

  const dirty =
    movies !== info.paths.movies
    || tv     !== info.paths.tv
    || anime  !== info.paths.anime
    || music  !== info.paths.music;

  const valid = [movies, tv, anime, music].every(p => p.trim().length > 0);

  async function save() {
    if (!dirty || !valid) return;
    const ok = await confirmDialog(
      t('mediaPaths.confirmMessage'),
      t('mediaPaths.confirmTitle'),
    );
    if (!ok) return;

    setSaving(true);
    try {
      const updates: Record<string, string> = {};
      // Docker Compose requires POSIX-style paths; normalise backslashes
      // before sending so the .env stays Compose-compatible.
      const norm = (p: string) => p.trim().replace(/\\/g, '/');
      if (movies !== info.paths.movies) updates.MOVIES_PATH = norm(movies);
      if (tv     !== info.paths.tv)     updates.TV_PATH     = norm(tv);
      if (anime  !== info.paths.anime)  updates.ANIME_PATH  = norm(anime);
      if (music  !== info.paths.music)  updates.MUSIC_PATH  = norm(music);

      const result = await api.setupPatchEnv(updates);
      if (result.errors.length > 0) {
        toast(t('error', { message: result.errors[0]!.message }), 'error');
        return;
      }
      await applyEnvChanges(result);
      qc.invalidateQueries({ queryKey: ['setup-info'] });
      qc.invalidateQueries({ queryKey: ['services'] });
      toast(t('mediaPaths.updated'), 'success');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title={t('mediaPaths.title')}
      subtitle={t('mediaPaths.subtitle')}
    >
      <PathRow label={t('mediaPaths.movies')} value={movies} onChange={setMovies} />
      <PathRow label={t('mediaPaths.tv')}     value={tv}     onChange={setTv} />
      <PathRow label={t('mediaPaths.anime')}  value={anime}  onChange={setAnime} />
      <PathRow label={t('mediaPaths.music')}  value={music}  onChange={setMusic} />

      <span className={styles.hintBox}>
        <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        {t('mediaPaths.hint')}
      </span>

      <SaveBar dirty={dirty && valid} saving={saving} onSave={save} />
    </Section>
  );
}

function PathRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('settings');
  async function browse() {
    const picked = await pickDirectory(value);
    if (picked) onChange(picked);
  }
  return (
    <div className={styles.formField}>
      <label className={styles.label}>{label}</label>
      <div className={styles.passwordRow}>
        <div className={styles.passwordInput}>
          <GlassInput value={value} onChange={onChange} placeholder="./media/…" />
        </div>
        <GlassButton variant="secondary" size="sm" onClick={() => void browse()}>
          <Folder size={13} />
          {t('mediaPaths.browse')}
        </GlassButton>
      </div>
    </div>
  );
}

// ─── App preferences (PR 3.4c) ────────────────────────────────────────────────

function PreferencesSection() {
  const { prefs, updatePrefs } = useAppPreferences();
  const { toast } = useToast();
  const { t } = useTranslation('settings');

  const PROFILE_OPTIONS: Array<{ value: RefreshProfile; label: string; hint: string }> = [
    { value: 'realtime', label: t('preferences.profiles.realtime'), hint: t('preferences.profiles.realtimeHint') },
    { value: 'balanced', label: t('preferences.profiles.balanced'),  hint: t('preferences.profiles.balancedHint') },
    { value: 'battery',  label: t('preferences.profiles.battery'),   hint: t('preferences.profiles.batteryHint') },
  ];

  const LOCALE_OPTIONS: Array<{ value: Locale; label: string; hint: string }> = [
    { value: 'en', label: t('preferences.locales.en'),  hint: t('preferences.locales.enHint') },
    { value: 'es', label: t('preferences.locales.es'),  hint: t('preferences.locales.esHint') },
  ];

  // Library auto-refresh options: minutes between forced Jellyfin scans.
  // 0 disables the timer entirely.
  const LIBRARY_REFRESH_OPTIONS: Array<{ value: number; label: string }> = [
    { value: 0,    label: t('preferences.libraryRefresh.off')      },
    { value: 60,   label: t('preferences.libraryRefresh.hourly')   },
    { value: 360,  label: t('preferences.libraryRefresh.every6h')  },
    { value: 1440, label: t('preferences.libraryRefresh.daily')    },
  ];

  async function setProfile(value: RefreshProfile) {
    if (value === prefs.refreshProfile) return;
    try {
      await updatePrefs({ refreshProfile: value });
      toast(t('preferences.refreshUpdated'), 'success');
    } catch (err) {
      toast(t('preferences.saveError', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  async function setLocale(value: Locale) {
    if (value === prefs.locale) return;
    try {
      await updatePrefs({ locale: value });
      toast(t('preferences.langUpdated'), 'success');
    } catch (err) {
      toast(t('preferences.saveError', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  async function setLibraryRefresh(value: number) {
    if (value === prefs.libraryRefreshMinutes) return;
    try {
      await updatePrefs({ libraryRefreshMinutes: value });
      toast(t('preferences.libraryRefresh.updated'), 'success');
    } catch (err) {
      toast(t('preferences.saveError', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  const activeProfileHint = PROFILE_OPTIONS.find(o => o.value === prefs.refreshProfile)?.hint ?? '';
  const activeLocaleHint  = LOCALE_OPTIONS.find(o  => o.value === prefs.locale)?.hint ?? '';

  return (
    <Section
      title={t('preferences.title')}
      subtitle={t('preferences.subtitle')}
    >
      <div className={styles.formField}>
        <label className={styles.label}>{t('preferences.refreshProfile')}</label>
        <SegmentedControl
          value={prefs.refreshProfile}
          onChange={v => void setProfile(v as RefreshProfile)}
          options={PROFILE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
        />
        <span className={styles.hint}>{activeProfileHint}</span>
      </div>

      <div className={styles.formField}>
        <label className={styles.label}>{t('preferences.libraryRefresh.label')}</label>
        <SegmentedControl
          value={String(prefs.libraryRefreshMinutes)}
          onChange={v => void setLibraryRefresh(parseInt(v, 10) || 0)}
          options={LIBRARY_REFRESH_OPTIONS.map(o => ({ value: String(o.value), label: o.label }))}
        />
        <span className={styles.hint}>{t('preferences.libraryRefresh.hint')}</span>
      </div>

      <div className={styles.formField}>
        <label className={styles.label}>{t('preferences.language')}</label>
        <SegmentedControl
          value={prefs.locale}
          onChange={v => void setLocale(v as Locale)}
          options={LOCALE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
        />
        <span className={styles.hint}>{activeLocaleHint}</span>
      </div>
    </Section>
  );
}

// ─── Stack lifecycle (actions) ───────────────────────────────────────────────

function StackLifecycleSection() {
  const [busy, setBusy] = useState<null | 'restart' | 'stop' | 'start'>(null);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { t } = useTranslation('settings');

  async function run(kind: 'restart' | 'stop' | 'start') {
    const labels: Record<typeof kind, { verb: string; toast: string; title: string }> = {
      restart: { verb: t('lifecycle.restartVerb'), toast: t('lifecycle.restartToast'), title: t('lifecycle.restartTitle') },
      stop:    { verb: t('lifecycle.stopVerb'),    toast: t('lifecycle.stopToast'),   title: t('lifecycle.stopTitle') },
      start:   { verb: t('lifecycle.startVerb'),   toast: t('lifecycle.startToast'),   title: t('lifecycle.startTitle') },
    };
    const ok = await confirmDialog(
      t('lifecycle.confirmMessage', { verb: labels[kind].verb }),
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
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title={t('lifecycle.title')} subtitle={t('lifecycle.subtitle')}>
      <div className={styles.actionsRow}>
        <GlassButton variant="secondary" onClick={() => run('start')} disabled={busy !== null}>
          {busy === 'start' ? <RotateCw size={14} className={styles.spin} /> : <Play size={14} />}
          {t('lifecycle.startAll')}
        </GlassButton>
        <GlassButton variant="secondary" onClick={() => run('restart')} disabled={busy !== null}>
          {busy === 'restart' ? <RotateCw size={14} className={styles.spin} /> : <RotateCw size={14} />}
          {t('lifecycle.restartAll')}
        </GlassButton>
        <GlassButton variant="secondary" onClick={() => run('stop')} disabled={busy !== null}>
          {busy === 'stop' ? <RotateCw size={14} className={styles.spin} /> : <Power size={14} />}
          {t('lifecycle.stopAll')}
        </GlassButton>
      </div>
    </Section>
  );
}

// ─── Update checker ──────────────────────────────────────────────────────────

function UpdatesSection() {
  const [showDrawer, setShowDrawer] = useState(false);
  const qc = useQueryClient();
  const { t } = useTranslation('settings');

  return (
    <Section
      title={t('updates.title')}
      subtitle={t('updates.subtitle')}
    >
      <div className={styles.actionsRow}>
        <GlassButton variant="secondary" onClick={() => setShowDrawer(true)}>
          <Download size={14} />
          {t('updates.check')}
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
  const [busy, setBusy] = useState<null | 'export' | 'import'>(null);
  const { t } = useTranslation('settings');

  async function openStackFolder() {
    if (!info.stack.workDir) return;
    try {
      await openPath(info.stack.workDir);
    } catch (err) {
      toast(t('advanced.openError', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  async function exportConfig() {
    setBusy('export');
    try {
      const result = await exportConfigToZip();
      if (!result) return; // user cancelled the picker
      const parts = [
        result.includedState ? 'state.json' : null,
        result.includedEnv   ? '.env' : null,
      ].filter(Boolean).join(' + ');
      toast(t('advanced.exportSuccess', { parts }), 'success');
    } catch (err) {
      toast(t('advanced.exportError', { error: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function importConfig() {
    const ok = await confirmDialog(
      t('advanced.importConfirmMessage'),
      t('advanced.importConfirmTitle'),
    );
    if (!ok) return;

    setBusy('import');
    try {
      const result = await importConfigFromZip();
      if (!result) return; // user cancelled the picker
      const parts = [
        result.restoredState ? 'state.json' : null,
        result.restoredEnv   ? `.env → ${result.envPath}` : null,
      ].filter(Boolean).join(', ');
      toast(t('advanced.importSuccess', { parts }), 'success');
      await restartSidecar();
      await reloadRuntimeConfig();
    } catch (err) {
      toast(t('advanced.importError', { error: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function rerunWizard() {
    const ok = await confirmDialog(
      t('advanced.wizardConfirmMessage'),
      t('advanced.wizardConfirmTitle'),
    );
    if (!ok) return;
    try {
      await resetAppState();
      toast(t('advanced.wizardCleared'), 'info');
    } catch (err) {
      toast(t('error', { message: err instanceof Error ? err.message : String(err) }), 'error');
    }
  }

  return (
    <Section title={t('advanced.title')}>
      <div className={styles.actionsRow}>
        {info.stack.workDir && (
          <GlassButton variant="secondary" onClick={() => void openStackFolder()}>
            <FolderOpen size={14} />
            {t('advanced.openFolder')}
          </GlassButton>
        )}
        <GlassButton variant="secondary" onClick={() => void exportConfig()} disabled={busy !== null}>
          {busy === 'export' ? <RotateCw size={14} className={styles.spin} /> : <Archive size={14} />}
          {t('advanced.exportConfig')}
        </GlassButton>
        <GlassButton variant="secondary" onClick={() => void importConfig()} disabled={busy !== null}>
          {busy === 'import' ? <RotateCw size={14} className={styles.spin} /> : <Upload size={14} />}
          {t('advanced.importConfig')}
        </GlassButton>
        <GlassButton variant="secondary" onClick={rerunWizard}>
          <Trash2 size={14} />
          {t('advanced.rerunWizard')}
        </GlassButton>
      </div>
      <span className={styles.hintBox}>
        <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
        <Trans t={t} i18nKey="advanced.wizardHint">Re-running the wizard only clears <code>state.json</code>. Docker containers keep running — to start completely fresh, also run <code>docker compose down -v</code> in the stack folder.</Trans>
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

/**
 * Apply both the restart and recreate targets returned by PATCH /env. Used
 * by sections that touch infrastructure-level env vars (paths, TZ, PUID,
 * PGID) where some keys need a `restart` and others need a `recreate` —
 * recreates run after restarts because they take longer and Docker locks
 * the project.
 */
async function applyEnvChanges(result: {
  restartRequired:  string[];
  recreateRequired: string[];
}): Promise<void> {
  await applyRestarts(result.restartRequired);
  if (result.recreateRequired.length > 0) {
    // The "all" sentinel and any docker service names go through the
    // recreate-services endpoint; sidecar isn't a docker container so we
    // skip it here (it's already in restart targets above when needed).
    const recreateTargets = result.recreateRequired.filter(s => s !== 'sidecar');
    if (recreateTargets.length > 0) {
      await api.setupRecreateServices(recreateTargets);
    }
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
  const { t } = useTranslation('settings');
  return (
    <div className={styles.saveBar}>
      {dirty && <span className={styles.dirty}>{t('saveBar.dirty')}</span>}
      <GlassButton variant="primary" size="sm" onClick={onSave} disabled={!dirty || saving}>
        {saving ? <RotateCw size={14} className={styles.spin} /> : <Save size={14} />}
        {t('saveBar.save')}
      </GlassButton>
    </div>
  );
}
