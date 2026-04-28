/* ─── i18n initializer (PR 3.4d) ───────────────────────────────────────────────
 * Bootstraps i18next + react-i18next with English as the source-of-truth
 * locale. Spanish is reserved as a stub bundle so the language selector in
 * Settings can switch to it without crashing — the actual Spanish strings
 * land in a follow-up PR.
 *
 * Locale source-of-truth:
 *   • App.tsx mounts <I18nProvider> after <AppPreferencesProvider>, so the
 *     active locale comes from `useLocale()` and i18next's language is kept
 *     in sync via a small effect inside that wrapper component.
 *   • A `useLanguageSync()` companion (in this same module) pushes locale
 *     changes from the preferences store into i18next.
 *   • Every translation key falls back to English via i18next's
 *     `fallbackLng`, so missing keys in the Spanish bundle render the
 *     English copy instead of the literal key.
 * ──────────────────────────────────────────────────────────────────────── */
import { useEffect } from 'react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enCommon from '@/locales/en/common.json';
import esCommon from '@/locales/es/common.json';
import enWizard from '@/locales/en/wizard.json';
import esWizard from '@/locales/es/wizard.json';
import enSettings from '@/locales/en/settings.json';
import esSettings from '@/locales/es/settings.json';
import { useLocale } from './use-app-preferences';

export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type   SupportedLocale  = (typeof SUPPORTED_LOCALES)[number];

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon, wizard: enWizard, settings: enSettings },
      es: { common: esCommon, wizard: esWizard, settings: esSettings },
    },
    lng:           'en',
    fallbackLng:   'en',
    defaultNS:     'common',
    ns:            ['common', 'wizard', 'settings'],
    interpolation: { escapeValue: false },
    returnNull:    false,
  });

/**
 * Keeps i18next's active language in sync with the preferences store.
 * Mount once near the React tree root, after AppPreferencesProvider.
 */
export function useLanguageSync(): void {
  const locale = useLocale();
  useEffect(() => {
    if (i18n.language !== locale) void i18n.changeLanguage(locale);
  }, [locale]);
}

export default i18n;
