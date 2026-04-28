import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import { useAppPreferences, type Locale } from '@/lib/use-app-preferences';

/**
 * First wizard step. Picking a language calls `updatePrefs({ locale })`,
 * which both persists to `state.json` and pushes the change into i18next
 * via `useLanguageSync()` — so every subsequent wizard screen renders in
 * the chosen language live, with no app restart.
 *
 * Spanish (and any other future locale) falls back to English for keys not
 * yet translated, so picking a partially-translated language never crashes
 * the wizard — worst case the user sees a few English strings.
 */
export function LanguageStep() {
  const { t } = useTranslation('wizard');
  const { prefs, updatePrefs } = useAppPreferences();

  const onChange = (next: string) => {
    if (next === prefs.locale) return;
    void updatePrefs({ locale: next as Locale });
  };

  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        {t('language.intro')}
      </p>

      <div className="wizard-field">
        <label className="wizard-label">
          {t('stepTitles.language')}
        </label>
        <SegmentedControl
          value={prefs.locale}
          onChange={onChange}
          options={[
            { value: 'en', label: t('language.options.en') },
            { value: 'es', label: t('language.options.es') },
          ]}
        />
        <span className="wizard-hint">
          {t(`language.hint.${prefs.locale}`)}
        </span>
      </div>

      <span className="wizard-hint" style={{ marginTop: 'var(--space-1)' }}>
        {t('language.footnote')}
      </span>
    </>
  );
}
