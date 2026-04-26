use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Runtime configuration the webview needs to talk to the sidecar.
///
/// The Rust side picks an unused port and a random API key on startup, then
/// exposes them to the webview via the `get_runtime_config` Tauri command.
/// This avoids hard-coding ports or shipping secrets in the bundle.
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    /// Base URL the UI should hit, e.g. `http://127.0.0.1:53412`.
    pub api_url: String,
    /// Bearer token expected by the sidecar's `Authorization: Bearer <…>` middleware.
    pub internal_api_key: String,
    /// `true` once the sidecar has logged that it is listening.
    pub ready: bool,
}

pub type SharedRuntimeConfig = Arc<RwLock<RuntimeConfig>>;
