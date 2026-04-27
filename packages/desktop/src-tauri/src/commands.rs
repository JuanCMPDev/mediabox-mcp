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
