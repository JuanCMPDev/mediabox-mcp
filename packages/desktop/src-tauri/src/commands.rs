use tauri::State;

use crate::state::{RuntimeConfig, SharedRuntimeConfig};

/// Returns the current runtime configuration so the webview can build its
/// API base URL and bearer token. Called once at boot by the UI.
#[tauri::command]
pub async fn get_runtime_config(
    cfg: State<'_, SharedRuntimeConfig>,
) -> Result<RuntimeConfig, String> {
    Ok(cfg.read().await.clone())
}
