/* ─── App preferences (PR 3.4c) ────────────────────────────────────────────────
 * User-tunable knobs persisted to `state.json`'s `appPreferences` field via
 * the same Tauri set_app_state command the wizard uses. We expose them
 * through a React Context so:
 *   • Components read live values via `useAppPreferences()` and re-render
 *     the moment Settings updates them — no app reload required.
 *   • `useRefreshIntervals()` returns the per-query interval map for
 *     `queries.ts` so the dashboard's refetch cadence reacts immediately
 *     to a profile switch.
 *   • Persistence is best-effort: if the Tauri save fails (e.g. in browser
 *     dev where setAppState is a no-op), the in-memory value still updates
 *     so the rest of the session sees the new pref.
 * ──────────────────────────────────────────────────────────────────────── */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AppPreferences, AppState, Locale, RefreshProfile } from './tauri-bridge';
import { getAppState, setAppState } from './tauri-bridge';

export type { AppPreferences, Locale, RefreshProfile };

export const DEFAULT_PREFERENCES: AppPreferences = {
  refreshProfile:        'realtime',
  locale:                'en',
  libraryRefreshMinutes: 0,
};

/** Per-profile refresh intervals consumed by `queries.ts`. Numbers are ms.
 *  `realtime` matches the historical hardcoded values from before PR 3.4c. */
export const REFRESH_INTERVALS: Record<RefreshProfile, {
  health:    number;
  sessions:  number;
  downloads: number;
  services:  number;
  library:   number;
  setupInfo: number;
}> = {
  realtime: { health:  5_000, sessions:  3_000, downloads:  2_000, services: 15_000, library:  60_000, setupInfo:  30_000 },
  balanced: { health: 10_000, sessions:  5_000, downloads:  5_000, services: 30_000, library:  60_000, setupInfo:  60_000 },
  battery:  { health: 30_000, sessions: 15_000, downloads: 15_000, services: 60_000, library: 120_000, setupInfo: 120_000 },
};

interface PreferencesContext {
  prefs:        AppPreferences;
  updatePrefs:  (patch: Partial<AppPreferences>) => Promise<void>;
}

const PreferencesContext = createContext<PreferencesContext | null>(null);

interface ProviderProps {
  /** Initial value pulled from `getAppState().appPreferences` at app boot.
   *  Falls back to defaults when null/undefined. */
  initial:  AppPreferences | null | undefined;
  children: ReactNode;
}

export function AppPreferencesProvider({ initial, children }: ProviderProps) {
  const [prefs, setPrefs] = useState<AppPreferences>(() => initial ?? DEFAULT_PREFERENCES);

  const updatePrefs = useCallback(async (patch: Partial<AppPreferences>) => {
    setPrefs(prev => {
      const next = { ...prev, ...patch };
      // Persist to state.json — read current state, merge, write back so we
      // don't clobber wizardCompletedAt / stackDir / configSummary.
      void (async () => {
        try {
          const current: AppState = await getAppState();
          await setAppState({ ...current, appPreferences: next });
        } catch (err) {
          console.warn('[useAppPreferences] persist failed:', err);
        }
      })();
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, updatePrefs }), [prefs, updatePrefs]);

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function useAppPreferences(): PreferencesContext {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('useAppPreferences must be used inside <AppPreferencesProvider>');
  return ctx;
}

/** Convenience hook for queries.ts — returns the active interval map. */
export function useRefreshIntervals() {
  const { prefs } = useAppPreferences();
  return REFRESH_INTERVALS[prefs.refreshProfile];
}

/** Convenience hook for the i18n layer — returns the active locale. */
export function useLocale(): Locale {
  const { prefs } = useAppPreferences();
  return prefs.locale;
}
