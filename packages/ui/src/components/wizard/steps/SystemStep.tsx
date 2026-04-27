import { GlassInput } from '@/components/atoms/GlassInput';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setSystem: (patch: Partial<WizardDraft['system']>) => void;
}

export function SystemStep({ draft, setSystem }: Props) {
  return (
    <>
      <div className="wizard-field">
        <label className="wizard-label">Zona horaria</label>
        <GlassInput
          value={draft.system.timezone}
          onChange={v => setSystem({ timezone: v })}
          placeholder="Europe/Madrid"
        />
        <span className="wizard-hint">
          Formato IANA (<code>Continent/City</code>). Detectada del navegador. Afecta a los logs de Sonarr/Radarr y a las tareas programadas de Jellyfin.
        </span>
      </div>

      <div className="wizard-row">
        <div className="wizard-field">
          <label className="wizard-label">PUID</label>
          <GlassInput
            value={String(draft.system.puid)}
            onChange={v => setSystem({ puid: parseInt(v, 10) || 0 })}
            placeholder="1000"
          />
          <span className="wizard-hint">User ID que Docker usará para escribir archivos.</span>
        </div>
        <div className="wizard-field">
          <label className="wizard-label">PGID</label>
          <GlassInput
            value={String(draft.system.pgid)}
            onChange={v => setSystem({ pgid: parseInt(v, 10) || 0 })}
            placeholder="1000"
          />
          <span className="wizard-hint">Group ID, normalmente igual al PUID.</span>
        </div>
      </div>

      <div className="wizard-field" style={{
        background: 'var(--glass-tint)',
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
      }}>
        <span className="wizard-hint">
          💡 En Linux, ejecutá <code>id -u</code> e <code>id -g</code> en una terminal para ver los valores
          correctos para tu usuario. En Windows/macOS los defaults <code>1000:1000</code> casi siempre andan.
        </span>
      </div>
    </>
  );
}
