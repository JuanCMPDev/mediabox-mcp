use std::process::Command;
use tauri::{AppHandle, State};

use crate::sidecar;
use crate::state::{RuntimeConfig, SharedRuntimeConfig};

/// Returns the current runtime configuration so the webview can build its
/// API base URL and bearer token. Called once at boot by the UI.
#[tauri::command]
pub async fn get_runtime_config(
    cfg: State<'_, SharedRuntimeConfig>,
) -> Result<RuntimeConfig, String> {
    Ok(cfg.read().await.clone())
}

/// Kills the current mcp-server sidecar and spawns a fresh one. Called by
/// the wizard right after `set_app_state` so the new sidecar picks up the
/// freshly-generated `<stackDir>/.env` (API keys, paths, LLM provider).
/// Without this the user would have to close and reopen the app to see
/// the dashboard populate after a successful deploy.
#[tauri::command]
pub async fn restart_sidecar(app: AppHandle) -> Result<(), String> {
    sidecar::spawn(app)
        .await
        .map_err(|e| format!("respawn sidecar: {e}"))
}

/// Opens a folder (or file) in the OS-native file manager. Works around
/// `tauri-plugin-shell::open()` choking on Windows-style paths and malformed
/// `file://` URIs — we just call the OS handler directly.
///
/// Important: if `explorer.exe` receives a path it can't resolve (mixed
/// separators, non-existent folder), it silently opens the user's Documents
/// folder. To avoid that "every button opens Documents" UX, we normalise
/// separators on Windows and verify the path exists before invoking.
#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }

    let normalised: String = {
        #[cfg(target_os = "windows")]
        { trimmed.replace('/', "\\") }
        #[cfg(not(target_os = "windows"))]
        { trimmed.to_string() }
    };

    let path_buf = std::path::PathBuf::from(&normalised);
    if !path_buf.exists() {
        return Err(format!("path does not exist: {normalised}"));
    }

    // We `spawn()` instead of `status()` because Windows' `explorer.exe`
    // returns exit code 1 on success, which would look like a failure.
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&normalised)
            .spawn()
            .map_err(|e| format!("explorer: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&normalised)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&normalised)
            .spawn()
            .map_err(|e| format!("open: {e}"))?;
    }
    Ok(())
}
