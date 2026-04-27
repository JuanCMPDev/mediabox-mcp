mod commands;
mod sidecar;
mod state;
mod wizard;

use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

use crate::sidecar::SidecarChild;
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
        .manage(SidecarChild(Mutex::new(None)))
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
            commands::restart_sidecar,
            wizard::check_docker,
            wizard::get_app_state,
            wizard::set_app_state,
            wizard::reset_app_state,
            wizard::default_stack_dir,
            wizard::pick_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
