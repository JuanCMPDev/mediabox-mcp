import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { GlassInput } from '@/components/atoms/GlassInput';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setServices: (patch: Partial<WizardDraft['services']>) => void;
}

export function ServicesStep({ draft, setServices }: Props) {
  const { t } = useTranslation('wizard');
  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        <Trans i18nKey="services.intro" t={t}>
          Passwords are saved in the stack&apos;s <code>.env</code> file. Save them in a password manager
          if you want to log into each service&apos;s web UI later.
        </Trans>
      </p>

      <SectionHeading>Jellyfin</SectionHeading>
      <div className="wizard-row">
        <div className="wizard-field">
          <label className="wizard-label">{t('services.adminUsername')}</label>
          <GlassInput
            value={draft.services.jellyfinAdminUsername}
            onChange={v => setServices({ jellyfinAdminUsername: v })}
            placeholder="mediabox"
          />
        </div>
        <PasswordField
          label={t('services.password')}
          value={draft.services.jellyfinAdminPassword}
          onChange={v => setServices({ jellyfinAdminPassword: v })}
        />
      </div>

      <SectionHeading>qBittorrent</SectionHeading>
      <span className="wizard-hint" style={{ marginTop: 0 }}>
        <Trans i18nKey="services.qbitHint" t={t}>
          Web UI username is always <code>admin</code>. The password you set here is applied automatically.
        </Trans>
      </span>
      <PasswordField
        label={t('services.password')}
        value={draft.services.qbitPassword}
        onChange={v => setServices({ qbitPassword: v })}
      />

      <SectionHeading>PyLoad</SectionHeading>
      <span className="wizard-hint" style={{ marginTop: 0 }}>
        <Trans i18nKey="services.pyloadHint" t={t}>
          PyLoad starts with default credentials <code>pyload / pyload</code>. The official image doesn&apos;t
          let us change them at deploy time — rotate them later from PyLoad&apos;s web UI.
        </Trans>
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
  const { t } = useTranslation('wizard');
  return (
    <div className="wizard-field">
      <label className="wizard-label">{label}</label>
      <GlassInput
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={t('services.minChars')}
        iconRight={
          <button
            type="button"
            onClick={() => setShow(s => !s)}
            aria-label={show ? t('services.hidePassword') : t('services.showPassword')}
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
        <span className="wizard-error">{t('services.errorMinChars')}</span>
      )}
    </div>
  );
}