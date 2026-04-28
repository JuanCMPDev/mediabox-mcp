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
        Passwords are saved in the stack&apos;s <code>.env</code> file. Save them in a password manager
        if you want to log into each service&apos;s web UI later.
      </p>

      <SectionHeading>Jellyfin</SectionHeading>
      <div className="wizard-row">
        <div className="wizard-field">
          <label className="wizard-label">Admin username</label>
          <GlassInput
            value={draft.services.jellyfinAdminUsername}
            onChange={v => setServices({ jellyfinAdminUsername: v })}
            placeholder="mediabox"
          />
        </div>
        <PasswordField
          label="Password"
          value={draft.services.jellyfinAdminPassword}
          onChange={v => setServices({ jellyfinAdminPassword: v })}
        />
      </div>

      <SectionHeading>qBittorrent</SectionHeading>
      <span className="wizard-hint" style={{ marginTop: 0 }}>
        Web UI username is always <code>admin</code>. The password you set here is applied automatically.
      </span>
      <PasswordField
        label="Password"
        value={draft.services.qbitPassword}
        onChange={v => setServices({ qbitPassword: v })}
      />

      <SectionHeading>PyLoad</SectionHeading>
      <span className="wizard-hint" style={{ marginTop: 0 }}>
        PyLoad starts with default credentials <code>pyload / pyload</code>. The official image doesn&apos;t
        let us change them at deploy time — rotate them later from PyLoad&apos;s web UI.
      </span>
    </>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      font: '600 14px var(--font-sans)',
      color: 'var(--on-surface)',
      margin: 'var(--space-2) 0 0 0',
    }}>
      {children}
    </h3>
  );
}

function PasswordField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="wizard-field">
      <label className="wizard-label">{label}</label>
      <GlassInput
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder="Min. 8 characters"
        iconRight={
          <button
            type="button"
            onClick={() => setShow(s => !s)}
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
        }
      />
      {value.length > 0 && value.length < 8 && (
        <span className="wizard-error">At least 8 characters.</span>
      )}
    </div>
  );
}
