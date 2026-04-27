//! Tauri commands consumed by the first-launch setup wizard.
//!
//! Responsibilities split:
//!   • Pre-flight checks (Docker installed + daemon up)            → here
//!   • Persistent app state (wizard completion, chosen stack dir)  → here
//!   • Default workdir resolution (appConfigDir/stack)             → here
//!   • Native directory picker                                     → here
//!
//! The actual deploy execution lives in `mcp-server`'s
//! `POST /api/setup/start` endpoint (it imports `DockerCliDeployer`
//! from `@mediabox/core` and streams `DeployEvent`s as NDJSON). The
//! webview hits that endpoint directly — Rust does not proxy it.

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const STATE_FILENAME: &str = "state.json";
const STACK_SUBDIR: &str = "stack";

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// ISO-8601 timestamp set when the user finishes the wizard.
    /// `None` means the wizard has never completed.
    pub wizard_completed_at: Option<String>,
    /// Absolute path to the directory where docker-compose.yml + .env live.
    /// Defaults to `appConfigDir/stack` if the user accepts the suggestion.
    pub stack_dir: Option<String>,
    /// Sanitised snapshot of what the user picked in the wizard. Powers the
    /// settings panel; never contains passwords or API keys (those live only
    /// in the stack `.env` and are loaded by the sidecar at startup).
    pub config_summary: Option<ConfigSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSummary {
    pub deployment_mode:        String,
    pub image_tag:              String,
    pub base_domain:            Option<String>,
    pub timezone:               String,
    pub puid:                   u32,
    pub pgid:                   u32,
    pub paths:                  PathsSummary,
    pub jellyfin_admin_user:    String,
    pub pyload_user:            String,
    pub bazarr_enabled:         bool,
    pub ai_provider:            String,
    pub ai_model:               Option<String>,
    pub telegram_enabled:       bool,
    pub telegram_user_count:    u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PathsSummary {
    pub movies: String,
    pub tv:     String,
    pub anime:  String,
    pub music:  String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    /// `docker --version` exits 0.
    pub installed: bool,
    /// `docker info` exits 0 (i.e. the daemon is reachable).
    pub daemon_running: bool,
    /// `docker compose version` exits 0.
    pub compose_available: bool,
    /// Version string from `docker --version` if installed.
    pub version: Option<String>,
    /// Free-form error from the failed probe — surfaced in the UI for
    /// "click here to install Docker" guidance.
    pub error: Option<String>,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app_config_dir: {e}"))
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(STATE_FILENAME))
}

fn run_probe(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(if stderr.is_empty() {
            format!("{cmd} exited with status {}", output.status)
        } else {
            stderr.trim().to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Probes whether the host is ready to run `docker compose up`.
/// Never fails — if Docker is missing, fields just go false.
#[tauri::command]
pub async fn check_docker() -> Result<DockerStatus, String> {
    let mut status = DockerStatus {
        installed: false,
        daemon_running: false,
        compose_available: false,
        version: None,
        error: None,
    };

    match run_probe("docker", &["--version"]) {
        Ok(v) => {
            status.installed = true;
            status.version = Some(v);
        }
        Err(e) => {
            status.error = Some(format!("docker not found: {e}"));
            return Ok(status);
        }
    }

    if let Err(e) = run_probe("docker", &["info"]) {
        status.error = Some(format!("docker daemon unreachable: {e}"));
    } else {
        status.daemon_running = true;
    }

    if run_probe("docker", &["compose", "version"]).is_ok() {
        status.compose_available = true;
    } else if status.error.is_none() {
        status.error = Some("docker compose plugin missing".to_string());
    }

    Ok(status)
}

/// Returns the persistent app state (or `Default` if state.json doesn't exist
/// yet — that's the first-launch signal).
#[tauri::command]
pub async fn get_app_state(app: AppHandle) -> Result<AppState, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(AppState::default());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read state.json: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse state.json: {e}"))
}

/// Persists the app state to disk. The webview calls this once the wizard
/// reaches the "done" step.
#[tauri::command]
pub async fn set_app_state(app: AppHandle, state: AppState) -> Result<(), String> {
    let dir = config_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create config dir: {e}"))?;
    let raw = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize state: {e}"))?;
    std::fs::write(state_path(&app)?, raw).map_err(|e| format!("write state.json: {e}"))?;
    Ok(())
}

/// Deletes state.json so the wizard fires again on next launch.
/// Does NOT touch the deployed Docker stack — the user can clean that up
/// manually via the wizard's pre-flight or via Docker Desktop.
#[tauri::command]
pub async fn reset_app_state(app: AppHandle) -> Result<(), String> {
    let path = state_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("delete state.json: {e}"))?;
    }
    Ok(())
}

/// Default workdir suggested in the wizard's path-picker step.
/// Resolves to `<appConfigDir>/stack`, e.g.
/// `%APPDATA%\dev.mediabox.os\stack` on Windows.
#[tauri::command]
pub async fn default_stack_dir(app: AppHandle) -> Result<String, String> {
    Ok(config_dir(&app)?
        .join(STACK_SUBDIR)
        .to_string_lossy()
        .to_string())
}

/// Opens a native folder picker. Returns the chosen path, or `None` if the
/// user cancels. Pre-fills with `initial` if provided.
#[tauri::command]
pub async fn pick_directory(
    app: AppHandle,
    initial: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(p) = initial {
        builder = builder.set_directory(p);
    }
    builder.pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result = rx.await.map_err(|e| format!("dialog channel: {e}"))?;
    Ok(result.map(|p| p.to_string()))
}
