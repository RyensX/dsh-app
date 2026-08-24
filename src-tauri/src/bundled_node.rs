use std::path::PathBuf;
use tauri::AppHandle;

use crate::error::LaunchError;
use crate::model::BootstrapManifest;

pub fn resolve(_app: &AppHandle, bootstrap: &BootstrapManifest) -> Result<PathBuf, LaunchError> {
    let packaged = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .map(|path| path.join(executable_name()));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!(
            "node-{}{}",
            env!("DSH_APP_TARGET_TRIPLE"),
            std::env::consts::EXE_SUFFIX
        ));
    let node = packaged
        .filter(|path| path.is_file())
        .or_else(|| development.is_file().then_some(development))
        .ok_or_else(|| {
            LaunchError::new(
                "BUNDLED_NODE_MISSING",
                "The packaged Node runtime is missing",
                "Reinstall the Bundled edition from a verified DSH App installer.",
            )
        })?;

    if bootstrap.app.edition != "bundled" {
        return Err(LaunchError::new(
            "BUNDLED_NODE_MISSING",
            "The packaged runtime edition does not match",
            "This executable and its dsh runtime came from different editions.",
        ));
    }
    if bootstrap.node.version.is_empty()
        || bootstrap.node.archive.is_empty()
        || bootstrap.node.sha256.len() != 64
    {
        return Err(LaunchError::new(
            "BUNDLED_NODE_MISSING",
            "The packaged Node metadata is incomplete",
            "Rebuild or reinstall this DSH App edition.",
        ));
    }
    Ok(node)
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}
