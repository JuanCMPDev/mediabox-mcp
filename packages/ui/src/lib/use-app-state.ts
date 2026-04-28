import { useEffect, useState, useCallback } from 'react';
import { getAppState, type AppState } from './tauri-bridge';

interface UseAppStateResult {
  state:   AppState | null;
  loading: boolean;
  error:   string | null;
  refresh: () => Promise<void>;
}

/**
 * Reads the persistent app state from the Rust shell. While loading, the
 * caller (App.tsx) shows nothing — but BootGate already gated the render
 * so the gap is invisible to the user.
 */
export function useAppState(): UseAppStateResult {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await getAppState();
      setState(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { state, loading, error, refresh };
}
