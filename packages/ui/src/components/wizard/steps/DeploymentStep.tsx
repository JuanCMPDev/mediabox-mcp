import { Folder } from 'lucide-react';
import { GlassInput } from '@/components/atoms/GlassInput';
import { GlassButton } from '@/components/atoms/GlassButton';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import type { WizardDraft } from '@/lib/wizard-types';
import { pickDirectory } from '@/lib/tauri-bridge';

interface Props {
  draft: WizardDraft;
  setWorkDir:    (v: string) => void;
  setDeployment: (patch: Partial<WizardDraft['deployment']>) => void;
}

export function DeploymentStep({ draft, setWorkDir, setDeployment }: Props) {
  const browse = async () => {
    const picked = await pickDirectory(draft.workDir || undefined);
    if (picked) setWorkDir(picked);
  };

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
          {draft.deployment.mode === 'vps'    && 'Stack en un servidor público con Caddy + Let\'s Encrypt.'}
          {draft.deployment.mode === 'tunnel' && 'Stack local expuesto vía Cloudflare Tunnel — sin abrir puertos.'}
        </span>
      </div>

      <div className="wizard-field">
        <label className="wizard-label">Directorio del stack</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <GlassInput
              value={draft.workDir}
              onChange={setWorkDir}
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
