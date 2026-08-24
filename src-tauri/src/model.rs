use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::error::LaunchError;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LaunchStatus {
    Starting { message: String },
    Ready { url: String },
    Failed { error: LaunchError },
}

impl Default for LaunchStatus {
    fn default() -> Self {
        Self::Starting {
            message: "Preparing the packaged runtime...".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub builder_version: Option<u32>,
    pub app: AppManifest,
    pub dsh: DshManifest,
    pub native: NativeManifest,
    pub bundled_node: Option<BundledNodeManifest>,
    #[serde(default)]
    pub plugins: Vec<ManifestPlugin>,
    #[serde(default)]
    pub plugin_digest: String,
}

/// Signed application resources describe the baseline without requiring Lite to package dsh.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapManifest {
    pub schema_version: u32,
    pub app: AppManifest,
    pub dsh: DshSourceManifest,
    pub node: NodeDownloadManifest,
    pub plugin_digest: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AppManifest {
    pub version: String,
    pub edition: String,
    pub target: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshManifest {
    pub commit: String,
    #[serde(default)]
    pub commit_time: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    pub node_engine: String,
    #[serde(default)]
    pub credentials_layout: Option<String>,
    pub entry: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshSourceManifest {
    pub repository: String,
    pub commit: String,
    #[serde(default)]
    pub commit_time: Option<String>,
    pub tag: Option<String>,
    pub version: String,
    pub node_engine: String,
    pub package_manager: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDownloadManifest {
    pub version: String,
    pub base_url: String,
    pub archive: String,
    pub sha256: String,
    pub platform: String,
    pub arch: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeManifest {
    pub platform: String,
    pub arch: String,
    pub node_abi: String,
    pub node_pty_package: String,
    pub node_pty_spawn_helper: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BundledNodeManifest {
    pub version: String,
    pub archive: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ManifestPlugin {
    pub id: String,
    pub entry: String,
}

#[derive(Clone, Debug)]
pub struct RuntimeLayout {
    pub runtime_root: PathBuf,
    pub entry: PathBuf,
    pub spawn_helper: Option<PathBuf>,
    pub manifest: RuntimeManifest,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    pub edition: &'static str,
    pub app_version: String,
    pub dsh_version: String,
    pub dsh_commit: String,
    pub user_root: String,
    pub required_node: String,
}
