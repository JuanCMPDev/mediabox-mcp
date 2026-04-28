//! Backup / restore the credentials needed to reproduce a Mediabox install
//! on another machine. Bundles `state.json` (Tauri's app state — wizard
//! summary + stack dir) and `<stackDir>/.env` (every API key, password,
//! and tag the deploy generated) into a single zip.
//!
//! What we explicitly do NOT include:
//!   • Docker volumes (Jellyfin's database, *arr SQLite DBs, qBittorrent's
//!     Web-UI config, downloaded media). Those are gigabytes and Docker
//!     manages them — backup happens at the Docker level (`docker volume
//!     export`, BorgBackup, etc.).
//!   • `docker-compose.yml`. It's regenerated from the wizard input on
//!     re-deploy, so re-running the wizard with the imported state +
//!     `Re-correr wizard` from Settings is the supported restore flow.
//!
//! Restore semantics: writing the files BACK does not redeploy anything —
//! the user has to run the wizard again to bring up the docker stack at
//! the new location. The import is meant for "preserving credentials
//! across a reinstall," not for one-click migration.

use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

const STATE_FILENAME: &str = "state.json";
const ENV_FILENAME:   &str = ".env";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExportSummary {
    /// Number of files actually written into the zip. Always 1 or 2 depending
    /// on whether the wizard has completed and `.env` exists.
    pub files: u32,
    /// `state.json` was bundled.
    pub included_state: bool,
    /// `<stackDir>/.env` was bundled.
    pub included_env: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportSummary {
    pub restored_state: bool,
    pub restored_env:   bool,
    /// Path the .env was written to (handy to surface in the toast).
    pub env_path: Option<String>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app_config_dir: {e}"))
}

fn read_state_stack_dir(state_path: &PathBuf) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(state_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.get("stackDir")?.as_str().map(PathBuf::from)
}

/// Write `state.json` (always) and `<stackDir>/.env` (if available) into a
/// zip at `dest_path`. Returns counts so the UI toast can be specific.
#[tauri::command]
pub async fn export_config(app: AppHandle, dest_path: String) -> Result<ConfigExportSummary, String> {
    let dest = PathBuf::from(&dest_path);
    if dest.as_os_str().is_empty() {
        return Err("destination path is empty".to_string());
    }

    let state_path = config_dir(&app)?.join(STATE_FILENAME);
    if !state_path.exists() {
        return Err(format!(
            "no state.json at {} — wizard hasn't completed yet, nothing to back up",
            state_path.display(),
        ));
    }

    let file = File::create(&dest).map_err(|e| format!("create zip {}: {e}", dest.display()))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // 1. state.json
    zip.start_file(STATE_FILENAME, opts).map_err(|e| format!("zip state.json: {e}"))?;
    let mut state_bytes = Vec::new();
    File::open(&state_path).and_then(|mut f| f.read_to_end(&mut state_bytes))
        .map_err(|e| format!("read state.json: {e}"))?;
    zip.write_all(&state_bytes).map_err(|e| format!("write state.json: {e}"))?;

    // 2. .env — best-effort. Missing .env is normal for installs that haven't
    //    deployed yet; we still bundle state.json and report partial success.
    let mut included_env = false;
    if let Some(stack_dir) = read_state_stack_dir(&state_path) {
        let env_path = stack_dir.join(ENV_FILENAME);
        if let Ok(mut env_file) = File::open(&env_path) {
            let mut env_bytes = Vec::new();
            if env_file.read_to_end(&mut env_bytes).is_ok() {
                zip.start_file(ENV_FILENAME, opts).map_err(|e| format!("zip .env: {e}"))?;
                zip.write_all(&env_bytes).map_err(|e| format!("write .env: {e}"))?;
                included_env = true;
            }
        }
    }

    zip.finish().map_err(|e| format!("finalise zip: {e}"))?;

    Ok(ConfigExportSummary {
        files: if included_env { 2 } else { 1 },
        included_state: true,
        included_env,
    })
}

/// Read a previously-exported zip and write the files back. The caller is
/// responsible for restarting the sidecar after — `state.json` may now point
/// to a different `stackDir`, and `.env` may carry different credentials.
#[tauri::command]
pub async fn import_config(app: AppHandle, source_path: String) -> Result<ConfigImportSummary, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err(format!("zip not found at {}", src.display()));
    }

    let file = File::open(&src).map_err(|e| format!("open zip {}: {e}", src.display()))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;

    let cfg_dir = config_dir(&app)?;
    std::fs::create_dir_all(&cfg_dir).map_err(|e| format!("create config dir: {e}"))?;

    // 1. Pull state.json out and write it. Required.
    let mut state_bytes = Vec::new();
    {
        let mut entry = archive.by_name(STATE_FILENAME)
            .map_err(|_| format!("zip is missing {STATE_FILENAME}; not a Mediabox config bundle?"))?;
        entry.read_to_end(&mut state_bytes).map_err(|e| format!("read state.json from zip: {e}"))?;
    }
    let state_path = cfg_dir.join(STATE_FILENAME);
    std::fs::write(&state_path, &state_bytes).map_err(|e| format!("write state.json: {e}"))?;

    // 2. .env — optional. Resolve target directory from the freshly-restored
    //    state.json's stackDir; if the zip has no .env or state has no
    //    stackDir, skip silently.
    let mut restored_env = false;
    let mut env_path_str: Option<String> = None;

    if let Some(stack_dir) = read_state_stack_dir(&state_path) {
        let mut env_bytes = Vec::new();
        let env_present = match archive.by_name(ENV_FILENAME) {
            Ok(mut entry) => entry.read_to_end(&mut env_bytes).is_ok(),
            Err(_) => false,
        };
        if env_present {
            std::fs::create_dir_all(&stack_dir).map_err(|e| format!("create stack dir {}: {e}", stack_dir.display()))?;
            let env_path = stack_dir.join(ENV_FILENAME);
            std::fs::write(&env_path, &env_bytes).map_err(|e| format!("write .env: {e}"))?;
            restored_env = true;
            env_path_str = Some(env_path.to_string_lossy().into_owned());
        }
    }

    Ok(ConfigImportSummary {
        restored_state: true,
        restored_env,
        env_path: env_path_str,
    })
}
