mod commands;
mod sidecar;
mod state;

use std::sync::Arc;
use tokio::sync::RwLock;

use crate::state::SharedRuntimeConfig;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: SharedRuntimeConfig = Arc::new(RwLock::new(state::RuntimeConfig::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .manage(shared)
        .setup(|app| {
            let handle = app.handle().clone();
            // Spawn sidecar on a tokio task so we don't block setup().
            tauri::async_runtime::spawn(async move {
                if let Err(err) = sidecar::spawn(handle).await {
                    log::error!("Failed to start mcp-server sidecar: {err:?}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_runtime_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
