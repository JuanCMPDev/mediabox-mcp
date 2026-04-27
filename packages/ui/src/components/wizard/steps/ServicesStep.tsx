import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { GlassInput } from '@/components/atoms/GlassInput';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setServices: (patch: Partial<WizardDraft['services']>) => void;
}

export function ServicesStep({ draft, setServices }: Props) {
  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        Las contraseñas se guardan en el <code>.env</code> del stack y no se vuelven a pedir.
        Anotalas en un gestor de contraseñas si querés acceder por web a cada servicio.
      </p>

      <h3 style={{
        font: '600 14px var(--font-sans)',
        color: 'var(--on-surface)',
        margin: 'var(--space-2) 0 0 0',
      }}>Jellyfin (servidor de medios)</h3>
      <div className="wizard-row">
        <div className="wizard-field">
          <label className="wizard-label">Usuario admin</label>
          <GlassInput
            value={draft.services.jellyfinAdminUsername}
            onChange={v => setServices({ jellyfinAdminUsername: v })}
            placeholder="mediabox"
          />
        </div>
        <PasswordField
          label="Contraseña"
          value={draft.services.jellyfinAdminPassword}
          onChange={v => setServices({ jellyfinAdminPassword: v })}
        />
      </div>

      <h3 style={{
        font: '600 14px var(--font-sans)',
        color: 'var(--on-surface)',
        margin: 'var(--space-2) 0 0 0',
      }}>qBittorrent (descargas)</h3>
      <PasswordField
        label="Contraseña"
        value={draft.services.qbitPassword}
        onChange={v => setServices({ qbitPassword: v })}
      />

      <h3 style={{
        font: '600 14px var(--font-sans)',
        color: 'var(--on-surface)',
        margin: 'var(--space-2) 0 0 0',
      }}>PyLoad (descargas vía URL)</h3>
      <div className="wizard-row">
        <div className="wizard-field">
          <label className="wizard-label">Usuario</label>
          <GlassInput
            value={draft.services.pyloadUsername}
            onChange={v => setServices({ pyloadUsername: v })}
            placeholder="pyload"
          />
        </div>
        <PasswordField
          label="Contraseña"
          value={draft.services.pyloadPassword}
          onChange={v => setServices({ pyloadPassword: v })}
        />
      </div>
    </>
  );
}

function PasswordField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="wizard-field">
      <label className="wizard-label">{label}</label>
      <div style={{ position: 'relative' }}>
        {show
          ? <GlassInput value={value} onChange={onChange} placeholder="Mínimo 8 caracteres" />
          : <GlassInput value={'•'.repeat(value.length)} onChange={v => {
              // When masked, treat new chars as appends/deletes
              const len = v.length;
              if (len > value.length) onChange(value + v.slice(value.length));
              else onChange(value.slice(0, len));
            }} placeholder="Mínimo 8 caracteres" />}
        <button
          type="button"
          onClick={() => setShow(s => !s)}
          aria-label={show ? 'Ocultar' : 'Mostrar'}
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            color: 'var(--on-surface-muted)',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {value.length > 0 && value.length < 8 && (
        <span className="wizard-error">Al menos 8 caracteres.</span>
      )}
    </div>
  );
}
