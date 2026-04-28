import { Trans, useTranslation } from 'react-i18next';
import { GlassInput } from '@/components/atoms/GlassInput';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setAI: (patch: Partial<WizardDraft['ai']>) => void;
}

export function AIProviderStep({ draft, setAI }: Props) {
  const { t } = useTranslation('wizard');
  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        {t('ai.intro')}
      </p>

      <div className="wizard-field">
        <label className="wizard-label">{t('ai.providerLabel')}</label>
        <SegmentedControl
          value={draft.ai.provider}
          onChange={v => setAI({ provider: v as WizardDraft['ai']['provider'] })}
          options={[
            { value: 'none',       label: t('ai.providers.none') },
            { value: 'openrouter', label: t('ai.providers.openrouter') },
            { value: 'google',     label: t('ai.providers.google') },
          ]}
        />
        <span className="wizard-hint">
          {draft.ai.provider === 'none'       && t('ai.hints.none')}
          {draft.ai.provider === 'openrouter' && t('ai.hints.openrouter')}
          {draft.ai.provider === 'google'     && t('ai.hints.google')}
        </span>
      </div>

      {draft.ai.provider !== 'none' && (
        <>
          <div className="wizard-field">
            <label className="wizard-label">{t('ai.apiKeyLabel')}</label>
            <GlassInput
              value={draft.ai.apiKey}
              onChange={v => setAI({ apiKey: v })}
              placeholder={draft.ai.provider === 'openrouter' ? 'sk-or-v1-…' : 'AIza…'}
            />
          </div>

          {draft.ai.provider === 'openrouter' && (
            <div className="wizard-field">
              <label className="wizard-label">{t('ai.modelLabel')}</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="openai/gpt-4o"
              />
              <span className="wizard-hint">
                <Trans i18nKey="ai.hints.openrouterModel" t={t}>
                  Recommended: <code>openai/gpt-4o</code> or <code>google/gemini-2.5-flash</code>.
                </Trans>
              </span>
            </div>
          )}

          {draft.ai.provider === 'google' && (
            <div className="wizard-field">
              <label className="wizard-label">{t('ai.googleModelLabel')}</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="gemini-2.5-flash"
              />
              <span className="wizard-hint">
                <Trans i18nKey="ai.hints.googleModel" t={t}>
                  Recommended: <code>gemini-2.5-flash</code>. Leave blank to use the SDK default.
                </Trans>
              </span>
            </div>
          )}
        </>
      )}
    </>
  );
}