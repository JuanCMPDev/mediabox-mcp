import { Trans, useTranslation } from 'react-i18next';
import { GlassInput } from '@/components/atoms/GlassInput';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setTelegram: (patch: Partial<WizardDraft['telegram']>) => void;
}

export function TelegramStep({ draft, setTelegram }: Props) {
  const { t } = useTranslation('wizard');
  const aiConfigured = draft.ai.provider !== 'none' && draft.ai.apiKey.trim().length > 0;

  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        <Trans i18nKey="telegram.intro" t={t}>
          The Telegram bot mirrors the in-app AI chat to your phone. You&apos;ll need a bot token
          from <code>@BotFather</code> and an AI provider configured.
        </Trans>
      </p>

      <div className="wizard-field">
        <label className="wizard-label">{t('telegram.enableLabel')}</label>
        <SegmentedControl
          value={draft.telegram.enabled ? 'on' : 'off'}
          onChange={v => setTelegram({ enabled: v === 'on' })}
          options={[
            { value: 'off', label: t('telegram.enableOptions.off') },
            { value: 'on',  label: t('telegram.enableOptions.on') },
          ]}
        />
      </div>

      {draft.telegram.enabled && !aiConfigured && (
        <div style={{
          padding: 'var(--space-2)',
          background: 'rgba(255, 180, 171, 0.08)',
          border: '1px solid rgba(255, 180, 171, 0.20)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--error)',
          font: '13px var(--font-sans)',
        }}>
          {t('telegram.needsAi')}
        </div>
      )}

      {draft.telegram.enabled && aiConfigured && (
        <>
          <div className="wizard-field">
            <label className="wizard-label">{t('telegram.tokenLabel')}</label>
            <GlassInput
              value={draft.telegram.botToken}
              onChange={v => setTelegram({ botToken: v })}
              placeholder="123456:ABC-DEF…"
            />
            <span className="wizard-hint">
              <Trans i18nKey="telegram.tokenHint" t={t}>
                Talk to <code>@BotFather</code> on Telegram and create a new bot with <code>/newbot</code>.
              </Trans>
            </span>
          </div>

          <div className="wizard-field">
            <label className="wizard-label">{t('telegram.usersLabel')}</label>
            <GlassInput
              value={draft.telegram.allowedUserIds}
              onChange={v => setTelegram({ allowedUserIds: v })}
              placeholder="123456789, 987654321"
            />
            <span className="wizard-hint">
              <Trans i18nKey="telegram.usersHint" t={t}>
                Comma-separated. Leave blank to allow anyone. Find your ID via <code>@userinfobot</code>.
              </Trans>
            </span>
          </div>
        </>
      )}
    </>
  );
}