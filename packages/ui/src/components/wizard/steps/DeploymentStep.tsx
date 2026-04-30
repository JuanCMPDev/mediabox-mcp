import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle, Folder, Loader, XCircle } from 'lucide-react';
import { GlassInput }       from '@/components/atoms/GlassInput';
import { GlassButton }      from '@/components/atoms/GlassButton';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import type { WizardDraft } from '@/lib/wizard-types';
import { pickDirectory, probeWorkdir, type WorkdirProbe } from '@/lib/tauri-bridge';

import styles from './DeploymentStep.module.css';

interface Props {
  draft: WizardDraft;
  setWorkDir:     (v: string) => void;
  setDeployment:  (patch: Partial<WizardDraft['deployment']>) => void;
  onProbeResult:  (probe: WorkdirProbe | null) => void;
}

export function DeploymentStep({ draft, setWorkDir, setDeployment, onProbeResult }: Props) {
  const { t } = useTranslation('wizard');
  const [probe,   setProbe]   = useState<WorkdirProbe | null>(null);
  const [probing, setProbing] = useState(false);

  // Debounce timer for manual text edits.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runProbe = async (path: string) => {
    if (!path.trim()) { setProbe(null); onProbeResult(null); return; }
    setProbing(true);
    try {
      const result = await probeWorkdir(path);
      setProbe(result);
      onProbeResult(result);
    } finally {
      setProbing(false);
    }
  };

  const handleWorkDirChange = (v: string) => {
    setWorkDir(v);
    // Reset probe immediately on change; run after debounce.
    setProbe(null);
    onProbeResult(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runProbe(v), 500);
  };

  const browse = async () => {
    const picked = await pickDirectory(draft.workDir || undefined);
    if (!picked) return;
    setWorkDir(picked);
    // Immediate probe on dialog pick (no debounce needed).
    await runProbe(picked);
  };

  // Probe the initial workDir on mount if it's already filled in.
  useEffect(() => {
    if (draft.workDir.trim()) void runProbe(draft.workDir);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="wizard-field">
        <label className="wizard-label">{t('deployment.modeLabel')}</label>
        <SegmentedControl
          value={draft.deployment.mode}
          onChange={v => setDeployment({ mode: v as WizardDraft['deployment']['mode'] })}
          options={[
            { value: 'local',  label: t('deployment.modes.local') },
            { value: 'vps',    label: t('deployment.modes.vps') },
            { value: 'tunnel', label: t('deployment.modes.tunnel') },
          ]}
        />
        <span className="wizard-hint">
          {draft.deployment.mode === 'local'  && t('deployment.hints.local')}
          {draft.deployment.mode === 'vps'    && t('deployment.hints.vps')}
          {draft.deployment.mode === 'tunnel' && t('deployment.hints.tunnel')}
        </span>
      </div>

      <div className="wizard-field">
        <label className="wizard-label">{t('deployment.folderLabel')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GlassInput
              value={draft.workDir}
              onChange={handleWorkDirChange}
              placeholder="C:\\Users\\you\\AppData\\Roaming\\dev.mediabox.os\\stack"
            />
          </div>
          <GlassButton variant="secondary" size="md" onClick={browse}>
            <Folder size={14} />
            {t('deployment.browse')}
          </GlassButton>
        </div>
        <span className="wizard-hint">
          <Trans i18nKey="deployment.folderHint" t={t}>
            We&apos;ll write <code>docker-compose.yml</code>, <code>.env</code>, and <code>config/</code> here.
          </Trans>
        </span>

        <WorkdirBanner probe={probe} probing={probing} t={t} />
      </div>

      {(draft.deployment.mode === 'vps' || draft.deployment.mode === 'tunnel') && (
        <div className="wizard-field">
          <label className="wizard-label">{t('deployment.domainLabel')}</label>
          <GlassInput
            value={draft.deployment.baseDomain}
            onChange={v => setDeployment({ baseDomain: v })}
            placeholder="mediabox.example.com"
          />
        </div>
      )}

      {draft.deployment.mode === 'vps' && (
        <div className="wizard-field">
          <label className="wizard-label">{t('deployment.emailLabel')}</label>
          <GlassInput
            value={draft.deployment.letsEncryptEmail}
            onChange={v => setDeployment({ letsEncryptEmail: v })}
            placeholder="admin@example.com"
          />
        </div>
      )}

      {draft.deployment.mode === 'tunnel' && (
        <div className="wizard-field">
          <label className="wizard-label">{t('deployment.tunnelTokenLabel')}</label>
          <GlassInput
            value={draft.deployment.tunnelToken}
            onChange={v => setDeployment({ tunnelToken: v })}
            placeholder="eyJh…"
          />
          <span className="wizard-hint">
            {t('deployment.tunnelTokenHint')}
          </span>
        </div>
      )}

      <div className="wizard-field">
        <label className="wizard-label">{t('deployment.imageTagLabel')}</label>
        <GlassInput
          value={draft.deployment.imageTag}
          onChange={v => setDeployment({ imageTag: v })}
          placeholder="latest"
        />
        <span className="wizard-hint">
          <Trans i18nKey="deployment.imageTagHint" t={t}>
            Pin to a specific tag (e.g. <code>v2.2.0</code>) for production instead of <code>latest</code>.
          </Trans>
        </span>
      </div>
    </>
  );
}

// ── Workdir compatibility banner ──────────────────────────────────────────────

interface BannerProps {
  probe:   WorkdirProbe | null;
  probing: boolean;
  t:       any;
}

function WorkdirBanner({ probe, probing, t }: BannerProps) {
  if (probing) {
    return (
      <div className={`${styles.banner} ${styles.bannerChecking}`}>
        <Loader size={14} className={styles.spin} />
        <span>{t('deployment.probe.checking')}</span>
      </div>
    );
  }

  if (!probe) return null;

  if (!probe.sqliteCompatible) {
    const fsLabel = probe.fsType ? ` (${probe.fsType})` : '';
    return (
      <div className={`${styles.banner} ${styles.bannerError}`}>
        <XCircle size={14} />
        <span>
          <Trans i18nKey="deployment.probe.incompatible" t={t} values={{ fsLabel }}>
            <strong>Incompatible filesystem{fsLabel}.</strong>{' '}
            Sonarr, Radarr, and Prowlarr won&apos;t start here — this filesystem doesn&apos;t
            support SQLite&apos;s WAL mode (typical on WSL2 9P bind-mounts, SMB, and NFS).{' '}
            <strong>Use <code>C:\</code> for the stack folder</strong> and point your media
            paths at your preferred drive in the next step.
          </Trans>
        </span>
      </div>
    );
  }

  if (!probe.isSystemDrive) {
    const fsLabel = probe.fsType ? ` (${probe.fsType})` : '';
    return (
      <div className={`${styles.banner} ${styles.bannerWarn}`}>
        <AlertTriangle size={14} />
        <span>
          <Trans i18nKey="deployment.probe.nonSystem" t={t} values={{ fsLabel }}>
            <strong>Non-system drive detected{fsLabel}.</strong>{' '}
            Docker Desktop + WSL2 can have file-locking issues on drives other than <code>C:\</code>.
            If Sonarr/Radarr/Prowlarr crash on startup, move the stack to <code>C:\</code>.
          </Trans>
        </span>
      </div>
    );
  }

  return (
    <div className={`${styles.banner} ${styles.bannerOk}`}>
      <CheckCircle size={14} />
      <span>
        {t('deployment.probe.ok', { fsLabel: probe.fsType ? ` (${probe.fsType})` : '' })}
      </span>
    </div>
  );
}