/* ─── Scheduled Jellyfin library refresh (PR 3.4 wrap-up) ──────────────────────
 * Mounts a single setInterval at the App root that hits
 * `POST /api/setup/jellyfin/refresh-library` every N minutes, where N is
 * the user's `libraryRefreshMinutes` preference. `0` disables the timer.
 *
 * The interval re-syncs whenever the preference changes (so flipping from
 * "off" to "every hour" in Settings starts a timer immediately and vice
 * versa). The fetch errors are swallowed with a console warning rather
 * than toasted — the manual refresh button surfaces feedback when the user
 * triggers it on demand.
 *
 * Note this is purely a webview-side timer: it only fires while the desktop
 * app is open. Long-term scheduling that runs without the app would belong
 * inside the sidecar / Docker layer, not here.
 * ──────────────────────────────────────────────────────────────────────── */
import { useEffect } from 'react';
import { api } from './api';
import { useAppPreferences } from './use-app-preferences';

const MS_PER_MINUTE = 60_000;

export function useLibraryAutoRefresh(): void {
  const { prefs } = useAppPreferences();
  const minutes = prefs.libraryRefreshMinutes;

  useEffect(() => {
    if (!minutes || minutes <= 0) return;
    const intervalMs = minutes * MS_PER_MINUTE;
    const id = window.setInterval(() => {
      void api.setupRefreshJellyfinLibrary().catch(err => {
        console.warn('[library-auto-refresh] failed:', err);
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [minutes]);
}
