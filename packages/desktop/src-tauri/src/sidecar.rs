use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rand::distributions::Alphanumeric;
use rand::Rng;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::state::SharedRuntimeConfig;

/// Holder for the running sidecar process. Lets `restart_sidecar` kill the
/// previous instance before spawning a fresh one (e.g. after the wizard
/// finishes and a new stack `.env` is on disk).
pub struct SidecarChild(pub Mutex<Option<CommandChild>>);

/// Spawn the bundled `mediabox-mcp` sidecar on a random free port with a
/// random bearer token. Reads `<stackDir>/.env` (if the wizard has already
/// completed) and forwards the relevant API keys + service URLs so the
/// dashboard widgets can talk to the deployed Docker stack.
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

    let (stack_dir, stack_env) = load_stack_env(&app);

    let mut cmd = app
        .shell()
        .sidecar("mediabox-mcp")?
        .env("PORT", port.to_string())
        .env("INTERNAL_API_KEY", &token)
        .env("PUBLIC_URL", &api_url)
        // Sidecar only ever talks to the embedded webview — bind loopback so
        // a misconfigured firewall can't expose the dashboard / MCP endpoint
        // to the LAN, and lock Origin to the Tauri webview origins so a
        // page in the user's regular browser can't reach the random port.
        .env("BIND_HOST", "127.0.0.1")
        .env(
            "ALLOWED_ORIGINS",
            "tauri://localhost,http://tauri.localhost,https://tauri.localhost",
        );

    // Pass the stackDir so the sidecar can edit `<stackDir>/.env` and run
    // `docker compose` against the right project. Without this, the admin
    // endpoints in /api/setup/* have no anchor to the user's deployment.
    if let Some(dir) = &stack_dir {
        cmd = cmd.env("STACK_DIR", dir);
    }

    // The sidecar runs ON the host (not inside the Docker network), so the
    // mcp-server defaults like `http://jellyfin:8096` are unresolvable.
    // Override every service URL with the host port that docker-compose maps.
    let host_overrides: &[(&str, &str)] = &[
        ("JELLYFIN_URL",     "http://localhost:8096"),
        ("SONARR_URL",       "http://localhost:8989"),
        ("RADARR_URL",       "http://localhost:7878"),
        ("PROWLARR_URL",     "http://localhost:9696"),
        ("QBIT_URL",         "http://localhost:8085"),
        ("PYLOAD_URL",       "http://localhost:8001"),  // 8001 host  → 8000 container
        ("PYLOAD_HOST_PORT", "8001"),
        ("FLARESOLVERR_URL", "http://localhost:8191"),
        ("BAZARR_URL",       "http://localhost:6767"),
    ];
    for (k, v) in host_overrides {
        cmd = cmd.env(*k, *v);
    }

    // Forward credentials + paths from the stack `.env` so the sidecar can
    // hit each service's API. Only pass keys we actually consume in mcp-server
    // (avoid leaking arbitrary deploy variables into the process env).
    //
    // ⚠ Names MUST match the keys written by `@mediabox/core/generators/env.ts`
    // and read by `@mediabox/chat-core/providers/select.ts`. The chat module
    // reads `LLM_PROVIDER` + `LLM_MODEL` (not `OPENROUTER_MODEL` etc.); without
    // them the provider falls back to defaults and the API call 400s.
    const FORWARDED: &[&str] = &[
        "JELLYFIN_ADMIN_USER",
        "JELLYFIN_API_KEY",
        "SONARR_API_KEY",
        "RADARR_API_KEY",
        "PROWLARR_API_KEY",
        "QBIT_USER",
        "QBIT_PASSWORD",
        "PYLOAD_USER",
        "PYLOAD_PASSWORD",
        "BAZARR_ENABLED",
        "MEDIA_PATH",
        "DOWNLOADS_PATH",
        "LLM_PROVIDER",
        "LLM_MODEL",
        "OPENROUTER_API_KEY",
        "GOOGLE_AI_API_KEY",
        "TELEGRAM_BOT_TOKEN",
        "ALLOWED_TELEGRAM_USERS",
    ];
    let mut forwarded_count = 0;
    for key in FORWARDED {
        if let Some(value) = stack_env.get(*key) {
            cmd = cmd.env(*key, value);
            forwarded_count += 1;
        }
    }

    // Fallback: deployments built before JELLYFIN_ADMIN_USER was written to
    // .env (the env generator only added it later) need the username from
    // state.json's configSummary so the Settings panel doesn't show "no
    // configurado" forever.
    if !stack_env.contains_key("JELLYFIN_ADMIN_USER") {
        if let Some(user) = load_jellyfin_admin_user(&app) {
            cmd = cmd.env("JELLYFIN_ADMIN_USER", &user);
            log::info!("[sidecar] JELLYFIN_ADMIN_USER injected from configSummary fallback");
        }
    }
    if forwarded_count > 0 {
        log::info!("[sidecar] forwarded {forwarded_count} env vars from stack .env");
    } else {
        log::info!("[sidecar] no stack .env found — running with defaults");
    }

    let (mut rx, child) = cmd.spawn()?;

    // Track the child so restart_sidecar can kill it later.
    if let Some(holder) = app.try_state::<SidecarChild>() {
        if let Ok(mut slot) = holder.0.lock() {
            // If a previous instance is still tracked, kill it first.
            if let Some(prev) = slot.take() {
                let _ = prev.kill();
            }
            *slot = Some(child);
        }
    }

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

/// Reads `state.json` and pulls `configSummary.jellyfinAdminUser`, used as a
/// fallback when the deployed `.env` predates the `JELLYFIN_ADMIN_USER` line.
fn load_jellyfin_admin_user(app: &AppHandle) -> Option<String> {
    let config_dir = app.path().app_config_dir().ok()?;
    let raw = std::fs::read_to_string(config_dir.join("state.json")).ok()?;
    let state: serde_json::Value = serde_json::from_str(&raw).ok()?;
    state
        .get("configSummary")?
        .get("jellyfinAdminUser")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Reads `state.json` to find `stackDir`, then parses `<stackDir>/.env` into
/// a flat HashMap. Returns `(None, {})` if state.json is missing or the wizard
/// has not completed; `(Some, {})` if state exists but .env is gone yet.
fn load_stack_env(app: &AppHandle) -> (Option<String>, HashMap<String, String>) {
    let mut out = HashMap::new();

    let Ok(config_dir) = app.path().app_config_dir() else { return (None, out); };
    let state_path = config_dir.join("state.json");
    let Ok(raw) = std::fs::read_to_string(&state_path) else { return (None, out); };
    let Ok(state) = serde_json::from_str::<serde_json::Value>(&raw) else { return (None, out); };
    let Some(stack_dir) = state.get("stackDir").and_then(|v| v.as_str()).map(String::from) else {
        return (None, out);
    };

    let env_path = PathBuf::from(&stack_dir).join(".env");
    let Ok(content) = std::fs::read_to_string(&env_path) else {
        log::info!("[sidecar] stack .env not found at {env_path:?}");
        return (Some(stack_dir), out);
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((k, v)) = line.split_once('=') {
            // Strip surrounding quotes if present (the env generator doesn't
            // quote, but be permissive).
            let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
            out.insert(k.trim().to_string(), value);
        }
    }
    log::info!("[sidecar] loaded {} entries from {env_path:?}", out.len());
    (Some(stack_dir), out)
}
