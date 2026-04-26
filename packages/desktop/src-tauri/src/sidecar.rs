use rand::distributions::Alphanumeric;
use rand::Rng;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::state::SharedRuntimeConfig;

/// Spawn the bundled `mediabox-mcp` sidecar on a random free port with a
/// random bearer token. Updates [`SharedRuntimeConfig`] so the webview can
/// pick up the URL + token via `get_runtime_config`.
pub async fn spawn(app: AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let port = portpicker::pick_unused_port().ok_or("no free TCP port available")?;
    let token: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect();
    let api_url = format!("http://127.0.0.1:{port}");

    {
        let cfg = app.state::<SharedRuntimeConfig>();
        let mut c = cfg.write().await;
        c.api_url = api_url.clone();
        c.internal_api_key = token.clone();
        c.ready = false;
    }

    log::info!("Spawning sidecar 'mediabox-mcp' on {api_url}");

    let cmd = app
        .shell()
        .sidecar("mediabox-mcp")?
        .env("PORT", port.to_string())
        .env("INTERNAL_API_KEY", &token)
        .env("PUBLIC_URL", &api_url);

    let (mut rx, _child) = cmd.spawn()?;

    let cfg_handle = app.state::<SharedRuntimeConfig>().inner().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let trimmed = line.trim_end();
                    if !trimmed.is_empty() {
                        log::info!("[sidecar] {trimmed}");
                    }
                    // The mcp-server logs `Mediabox MCP v… running on port …` once Express is listening.
                    if trimmed.contains("running on port") {
                        let mut c = cfg_handle.write().await;
                        c.ready = true;
                        log::info!("[sidecar] runtime config marked ready");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let trimmed = line.trim_end();
                    if !trimmed.is_empty() {
                        log::warn!("[sidecar:stderr] {trimmed}");
                    }
                }
                CommandEvent::Error(err) => {
                    log::error!("[sidecar] error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    log::error!(
                        "[sidecar] terminated (code: {:?}, signal: {:?})",
                        payload.code,
                        payload.signal
                    );
                    let mut c = cfg_handle.write().await;
                    c.ready = false;
                }
                _ => {}
            }
        }
    });

    Ok(())
}
