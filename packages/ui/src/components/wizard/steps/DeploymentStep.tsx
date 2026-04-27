import { useEffect, useRef, useState } from 'react';
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
        <label className="wizard-label">Modo de despliegue</label>
        <SegmentedControl
          value={draft.deployment.mode}
          onChange={v => setDeployment({ mode: v as WizardDraft['deployment']['mode'] })}
          options={[
            { value: 'local',  label: 'Local' },
            { value: 'vps',    label: 'VPS público' },
            { value: 'tunnel', label: 'Cloudflare Tunnel' },
          ]}
        />
        <span className="wizard-hint">
          {draft.deployment.mode === 'local'  && 'Stack accesible solo desde tu LAN. Lo más simple para uso doméstico.'}
          {draft.deployment.mode === 'vps'    && "Stack en un servidor público con Caddy + Let's Encrypt."}
          {draft.deployment.mode === 'tunnel' && 'Stack local expuesto vía Cloudflare Tunnel — sin abrir puertos.'}
        </span>
      </div>

      <div className="wizard-field">
        <label className="wizard-label">Directorio del stack</label>
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
            Elegir
          </GlassButton>
        </div>
        <span className="wizard-hint">
          Acá se generan <code>docker-compose.yml</code>, <code>.env</code> y la carpeta <code>config/</code>.
        </span>

        <WorkdirBanner probe={probe} probing={probing} />
      </div>

      {(draft.deployment.mode === 'vps' || draft.deployment.mode === 'tunnel') && (
        <div className="wizard-field">
          <label className="wizard-label">Dominio base</label>
          <GlassInput
            value={draft.deployment.baseDomain}
            onChange={v => setDeployment({ baseDomain: v })}
            placeholder="mediabox.example.com"
          />
        </div>
      )}

      {draft.deployment.mode === 'vps' && (
        <div className="wizard-field">
          <label className="wizard-label">Email para Let's Encrypt</label>
          <GlassInput
            value={draft.deployment.letsEncryptEmail}
            onChange={v => setDeployment({ letsEncryptEmail: v })}
            placeholder="admin@example.com"
          />
        </div>
      )}

      {draft.deployment.mode === 'tunnel' && (
        <div className="wizard-field">
          <label className="wizard-label">Token del Cloudflare Tunnel</label>
          <GlassInput
            value={draft.deployment.tunnelToken}
            onChange={v => setDeployment({ tunnelToken: v })}
            placeholder="eyJh…"
          />
          <span className="wizard-hint">
            Lo obtenés en el dashboard de Cloudflare Zero Trust → Networks → Tunnels.
          </span>
        </div>
      )}

      <div className="wizard-field">
        <label className="wizard-label">Tag de imagen (GHCR)</label>
        <GlassInput
          value={draft.deployment.imageTag}
          onChange={v => setDeployment({ imageTag: v })}
          placeholder="latest"
        />
        <span className="wizard-hint">
          Para producción, fijá un tag específico (ej. <code>v2.1.0</code>) en vez de <code>latest</code>.
        </span>
      </div>
    </>
  );
}

// ── Workdir compatibility banner ──────────────────────────────────────────────

interface BannerProps {
  probe:   WorkdirProbe | null;
  probing: boolean;
}

function WorkdirBanner({ probe, probing }: BannerProps) {
  if (probing) {
    return (
      <div className={`${styles.banner} ${styles.bannerChecking}`}>
        <Loader size={14} className={styles.spin} />
        <span>Verificando compatibilidad del sistema de archivos…</span>
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
          <strong>Sistema de archivos incompatible{fsLabel}.</strong>{' '}
          Sonarr, Radarr y Prowlarr fallarán con <code>SQLITE_CANTOPEN</code> al
          iniciarse porque el sistema de archivos no soporta el modo WAL de SQLite
          (requerido en bind-mounts WSL2 9P, SMB y NFS).{' '}
          <strong>Recomendamos usar <code>C:\</code> para el stack</strong> y apuntar
          las carpetas de medios a tu unidad preferida desde los pasos de Rutas.
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
          <strong>Unidad no-sistema detectada{fsLabel}.</strong>{' '}
          Docker Desktop + WSL2 puede tener problemas de file-locking en bind-mounts
          a unidades distintas de <code>C:\</code>. Si Sonarr/Radarr/Prowlarr fallan
          al iniciar, mové el stack a <code>C:\</code>.
        </span>
      </div>
    );
  }

  return (
    <div className={`${styles.banner} ${styles.bannerOk}`}>
      <CheckCircle size={14} />
      <span>
        Sistema de archivos compatible{probe.fsType ? ` (${probe.fsType})` : ''}.
      </span>
    </div>
  );
}
