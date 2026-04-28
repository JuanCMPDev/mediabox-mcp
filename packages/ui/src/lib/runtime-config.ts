/* ─── Runtime configuration resolver ────────────────────────────────────────
 * Resolves the API base URL + bearer token from one of two sources:
 *
 *   1. Tauri shell — calls the `get_runtime_config` Rust command, which
 *      returns the random port + token assigned to the bundled mcp-server
 *      sidecar. Polls until the sidecar reports `ready: true` (max 30s).
 *
 *   2. Browser dev / standalone web — falls back to Vite env vars
 *      (VITE_API_URL, VITE_INTERNAL_API_KEY).
 *
 * Boot order: `loadRuntimeConfig()` MUST resolve before any `api.*` or
 * `streamChat(...)` call. The <BootGate> component in App.tsx enforces this
 * by withholding the app render until the promise settles.
 * ──────────────────────────────────────────────────────────────────────── */

interface RuntimeConfig {
  apiUrl:         string;
  internalApiKey: string;
}

interface TauriRuntimeConfig {
  apiUrl:          string;
  internalApiKey:  string;
  ready:           boolean;
}

let cached: RuntimeConfig | null = null;
let inFlight: Promise<RuntimeConfig> | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && '__TAURI_INTERNALS__' in window;
}

async function loadFromTauri(): Promise<RuntimeConfig> {
  // Dynamic import keeps @tauri-apps/api out of the browser-only critical path.
  const { invoke } = await import('@tauri-apps/api/core');

  // Sidecar typically binds in <2s but allow up to 30s for cold-start scenarios
  // (large bun-compile binaries on slow disks, antivirus scans on Windows).
  const DEADLINE_MS = 30_000;
  const POLL_MS     = 250;
  const start       = Date.now();

  while (Date.now() - start < DEADLINE_MS) {
    const cfg = await invoke<TauriRuntimeConfig>('get_runtime_config');
    if (cfg.ready && cfg.apiUrl && cfg.internalApiKey) {
      return { apiUrl: cfg.apiUrl, internalApiKey: cfg.internalApiKey };
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error('Sidecar failed to start within 30 seconds');
}

function loadFromEnv(): RuntimeConfig {
  return {
    apiUrl:         import.meta.env.VITE_API_URL          || 'http://localhost:3000',
    internalApiKey: import.meta.env.VITE_INTERNAL_API_KEY || '',
  };
}

/**
 * Idempotent. Safe to call from multiple boot paths simultaneously — concurrent
 * callers share the same in-flight promise.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const cfg = isTauriRuntime() ? await loadFromTauri() : loadFromEnv();
    cached = cfg;
    return cfg;
  })();

  return inFlight;
}

/**
 * Synchronous accessor. Throws if called before `loadRuntimeConfig()` resolves.
 * Used by hot-path API helpers to avoid an async hop on every request.
 */
export function getRuntimeConfig(): RuntimeConfig {
  if (!cached) {
    throw new Error('Runtime config not loaded — call loadRuntimeConfig() before any API call');
  }
  return cached;
}

/** Test-only — resets internal state. */
export function __resetRuntimeConfig(): void {
  cached   = null;
  inFlight = null;
}

/**
 * Drops the cached config and re-polls. Used after `restart_sidecar` so the
 * webview picks up the new random port + bearer token without a page reload.
 */
export async function reloadRuntimeConfig(): Promise<RuntimeConfig> {
  cached = null;
  inFlight = null;
  return loadRuntimeConfig();
}
