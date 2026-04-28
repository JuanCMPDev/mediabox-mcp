mod backup;
mod commands;
mod sidecar;
mod state;
mod wizard;

use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

use tauri::{AppHandle, Manager, RunEvent};

use crate::sidecar::SidecarChild;
use crate::state::SharedRuntimeConfig;

/// Best-effort: kill the bundled mcp-server sidecar so it stops holding a
/// lock on `mediabox-mcp.exe`. Without this, re-installing the app fails on
/// Windows because the installer can't overwrite an in-use file.
fn kill_sidecar(handle: &AppHandle) {
    if let Some(holder) = handle.try_state::<SidecarChild>() {
        if let Ok(mut slot) = holder.0.lock() {
            if let Some(child) = slot.take() {
                let _ = child.kill();
            }
        }
    }
}

fn focus_main_window(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// macOS apps launched from Finder inherit a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), missing the directories where Homebrew
/// and Docker Desktop install their CLIs. Linux desktop launchers can have a
/// similar gap depending on how the user logged in. Augment PATH at process
/// start so:
///   - `Command::new("docker")` from the Rust pre-flight check finds it
///   - The bun-compiled sidecar (which inherits this process's environment)
///     can shell out to `docker compose up`, `docker compose pull`, etc.
/// Windows inherits PATH from explorer.exe correctly — Docker Desktop
/// installs into the system PATH — so we skip it there.
fn augment_path() {
    let extras: &[&str] = if cfg!(target_os = "macos") {
        &["/usr/local/bin", "/opt/homebrew/bin"]
    } else if cfg!(target_os = "linux") {
        &["/usr/local/bin", "/snap/bin"]
    } else {
        return;
    };

    let current = std::env::var("PATH").unwrap_or_default();
    let mut joined = current.clone();
    for &p in extras {
        // Cheap contains check is fine — PATH stays small.
        if !current.split(':').any(|x| x == p) {
            if !joined.is_empty() {
                joined.push(':');
            }
            joined.push_str(p);
        }
    }
    if joined != current {
        std::env::set_var("PATH", joined);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    augment_path();

    let shared: SharedRuntimeConfig = Arc::new(RwLock::new(state::RuntimeConfig::default()));

    let app = tauri::Builder::default()
        // ── Single-instance ─────────────────────────────────────────────────
        // Prevents a second mediabox-desktop.exe from spawning a duplicate
        // sidecar (which would race for ports and keep an extra `bun` process
        // alive even after the user closes one of the windows). When the user
        // double-clicks the shortcut while Mediabox is already running, the
        // existing window is focused instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            log::info!("[single-instance] focusing existing window");
            focus_main_window(app);
        }))
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
            commands::open_path,
            wizard::check_docker,
            wizard::get_app_state,
            wizard::set_app_state,
            wizard::reset_app_state,
            wizard::default_stack_dir,
            wizard::pick_directory,
            wizard::probe_workdir,
            backup::export_config,
            backup::import_config,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Kill the sidecar on every exit path. RunEvent::ExitRequested fires when
    // the last window is closed (X button), and RunEvent::Exit fires right
    // before the runtime tears down — covering OS shutdown, panics, etc.
    // The kill is idempotent: if the sidecar already exited, take() returns
    // None and this is a no-op.
    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            kill_sidecar(handle);
        }
    });
}
