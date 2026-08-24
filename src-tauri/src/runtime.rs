use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::error::LaunchError;
use crate::model::{BootstrapManifest, RuntimeLayout, RuntimeManifest};

pub fn resource_stage(app: &AppHandle) -> Result<PathBuf, LaunchError> {
    let packaged = app
        .path()
        .resource_dir()
        .map(|path| path.join("resources"))
        .map_err(|error| {
            runtime_error(
                "The application resource directory is unavailable",
                &error.to_string(),
            )
        })?;
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.build/stage");
    let stage_root = if packaged.join("bootstrap-manifest.json").is_file() {
        packaged
    } else {
        development
    };
    Ok(stage_root)
}

pub fn resolve_bootstrap(app: &AppHandle) -> Result<BootstrapManifest, LaunchError> {
    let stage = resource_stage(app)?;
    let path = stage.join("bootstrap-manifest.json");
    let source = fs::read_to_string(&path).map_err(|error| {
        runtime_error(
            "The application bootstrap manifest is missing",
            &format!("{}: {error}", path.display()),
        )
    })?;
    let manifest: BootstrapManifest = serde_json::from_str(&source)?;
    if manifest.schema_version != 1 {
        return Err(runtime_error(
            "The application bootstrap manifest is unsupported",
            &format!("schemaVersion {}", manifest.schema_version),
        ));
    }
    Ok(manifest)
}

pub fn resolve_packaged_runtime(app: &AppHandle) -> Result<Option<RuntimeLayout>, LaunchError> {
    let stage = resource_stage(app)?;
    if !stage.join("runtime-manifest.json").is_file() {
        return Ok(None);
    }
    load_layout(&stage).map(Some)
}

pub fn load_layout(stage_root: &Path) -> Result<RuntimeLayout, LaunchError> {
    let manifest_path = stage_root.join("runtime-manifest.json");
    let source = fs::read_to_string(&manifest_path).map_err(|error| {
        runtime_error(
            "The packaged runtime manifest is missing",
            &format!("{}: {error}", manifest_path.display()),
        )
    })?;
    let manifest: RuntimeManifest = serde_json::from_str(&source)?;
    if manifest.schema_version != 1 {
        return Err(runtime_error(
            "The packaged runtime manifest is unsupported",
            &format!("schemaVersion {}", manifest.schema_version),
        ));
    }
    let entry_relative = contained_relative(&manifest.dsh.entry)?;
    let entry = stage_root.join(&entry_relative);
    if !entry.is_file() {
        return Err(runtime_error(
            "The dsh runtime entry is missing",
            &entry.display().to_string(),
        ));
    }
    let runtime_root = stage_root.join("dsh-runtime");
    let spawn_helper = match &manifest.native.node_pty_spawn_helper {
        Some(path) => Some(runtime_root.join(contained_relative(path)?)),
        None => None,
    };
    if let Some(helper) = &spawn_helper {
        if !helper.is_file() {
            return Err(runtime_error(
                "The node-pty spawn helper is missing",
                &helper.display().to_string(),
            ));
        }
    }
    Ok(RuntimeLayout {
        runtime_root,
        entry,
        spawn_helper,
        manifest,
    })
}

fn contained_relative(path: &str) -> Result<PathBuf, LaunchError> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(runtime_error(
            "The packaged runtime contains an unsafe path",
            &path.display().to_string(),
        ));
    }
    Ok(path.to_path_buf())
}

fn runtime_error(message: &str, cause: &str) -> LaunchError {
    LaunchError::new("RUNTIME_INVALID", "The dsh runtime is unavailable", message)
        .detail("Underlying error", cause)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_manifest_paths_that_escape_resources() {
        assert!(contained_relative("../outside.js").is_err());
        assert!(contained_relative("/tmp/outside.js").is_err());
        assert_eq!(
            contained_relative("dsh-runtime/lib/bin.js").unwrap(),
            PathBuf::from("dsh-runtime/lib/bin.js")
        );
    }
}
