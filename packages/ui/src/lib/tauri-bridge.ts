/* ─── Tauri command bridge ────────────────────────────────────────────────────
 * Single point of contact between the React UI and the Rust shell. Detects
 * whether we're running inside a Tauri webview; if not (browser dev / vite),
 * commands fall back to deterministic stubs so the wizard remains testable
 * without spawning the desktop binary.
 * ──────────────────────────────────────────────────────────────────────── */

interface DockerStatus {
  installed:         boolean;
  daemonRunning:     boolean;
  composeAvailable:  boolean;
  version:           string | null;
  error:             string | null;
}

export interface PathsSummary {
  movies: string;
  tv:     string;
  anime:  string;
  music:  string;
}

export interface ConfigSummary {
  deploymentMode:    string;
  imageTag:          string;
  baseDomain:        string | null;
  timezone:          string;
  puid:              number;
  pgid:              number;
  paths:             PathsSummary;
  jellyfinAdminUser: string;
  pyloadUser:        string;
  bazarrEnabled:     boolean;
  aiProvider:        string;
  aiModel:           string | null;
  telegramEnabled:   boolean;
  telegramUserCount: number;
}

export interface AppState {
  wizardCompletedAt: string | null;
  stackDir:          string | null;
  configSummary:     ConfigSummary | null;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

// ── Pre-flight ────────────────────────────────────────────────────────────────

export async function checkDocker(): Promise<DockerStatus> {
  if (!inTauri()) {
    // Browser dev fallback — assume docker is fine so the wizard flow can be
    // navigated. Real check only happens under Tauri.
    return {
      installed: true,
      daemonRunning: true,
      composeAvailable: true,
      version: 'Docker version 28.0.0 (browser-dev mock)',
      error: null,
    };
  }
  return invoke<DockerStatus>('check_docker');
}

// ── App state ─────────────────────────────────────────────────────────────────

export async function getAppState(): Promise<AppState> {
  if (!inTauri()) {
    // Browser dev: pretend wizard is always complete so dashboard renders.
    // Set ?wizard=1 in the URL to force wizard mode in browser dev.
    if (new URLSearchParams(window.location.search).get('wizard') === '1') {
      return { wizardCompletedAt: null, stackDir: null, configSummary: null };
    }
    return {
      wizardCompletedAt: new Date().toISOString(),
      stackDir: '/dev/null/browser-mock',
      configSummary: null,
    };
  }
  return invoke<AppState>('get_app_state');
}

export async function setAppState(state: AppState): Promise<void> {
  if (!inTauri()) {
    // Persist to localStorage so reloads keep the same flag in browser dev.
    localStorage.setItem('mediabox:app-state', JSON.stringify(state));
    return;
  }
  return invoke<void>('set_app_state', { state });
}

/**
 * Deletes state.json so the wizard fires again on next launch. Used by
 * Settings → Avanzado → "Re-correr wizard".
 */
export async function resetAppState(): Promise<void> {
  if (!inTauri()) {
    localStorage.removeItem('mediabox:app-state');
    return;
  }
  return invoke<void>('reset_app_state');
}

// ── Workdir helpers ───────────────────────────────────────────────────────────

export async function defaultStackDir(): Promise<string> {
  if (!inTauri()) {
    return '/tmp/mediabox-stack';
  }
  return invoke<string>('default_stack_dir');
}

export async function pickDirectory(initial?: string): Promise<string | null> {
  if (!inTauri()) {
    // Browser dev: prompt instead of native picker.
    const result = window.prompt('Pick a directory (browser dev fallback)', initial ?? '');
    return result?.trim() || null;
  }
  return invoke<string | null>('pick_directory', { initial: initial ?? null });
}

// ── Workdir probe ─────────────────────────────────────────────────────────────

export interface WorkdirProbe {
  sqliteCompatible: boolean;
  fsType:           string | null;
  isSystemDrive:    boolean;
  probedPath:       string;
  error:            string | null;
}

/**
 * Probes whether the filesystem at `path` supports SQLite WAL mode.
 * The wizard calls this immediately after the user picks or types a workdir
 * so we can warn them before deploying to a filesystem where *arr services
 * will fail with SQLITE_CANTOPEN on startup (WSL2 9P bind-mounts, SMB, NFS).
 */
export async function probeWorkdir(path: string): Promise<WorkdirProbe> {
  if (!inTauri()) {
    // Browser dev fallback — pretend the path is fine.
    return {
      sqliteCompatible: true,
      fsType:           'NTFS',
      isSystemDrive:    true,
      probedPath:       path,
      error:            null,
    };
  }
  return invoke<WorkdirProbe>('probe_workdir', { path });
}

// ── Sidecar lifecycle ─────────────────────────────────────────────────────────

/**
 * Kills the running sidecar and spawns a fresh one. Called by the wizard
 * after the deploy completes so the new sidecar picks up the stack `.env`
 * (API keys, service URLs, LLM provider) the wizard just wrote.
 */
export async function restartSidecar(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>('restart_sidecar');
}

// ── Window controls (Tauri 2 webview) ─────────────────────────────────────────

export async function minimizeWindow(): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().minimize();
}

export async function toggleMaximize(): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

// ── Open external URL with the OS default handler ─────────────────────────────

export async function openExternal(url: string): Promise<void> {
  if (!inTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const { open } = await import('@tauri-apps/plugin-shell');
  await open(url);
}

// ── Native confirmation dialog ────────────────────────────────────────────────

export async function confirmDialog(message: string, title = 'Confirmar'): Promise<boolean> {
  if (!inTauri()) return window.confirm(`${title}\n\n${message}`);
  const { ask } = await import('@tauri-apps/plugin-dialog');
  return ask(message, { title, kind: 'warning' });
}
