use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::error::LaunchError;
use crate::model::{BootstrapManifest, RuntimeLayout, RuntimeManifest};

pub fn resource_stage(app: &AppHandle) -> Result<PathBuf, LaunchError> {
    let packaged = app
        .path()
        .resource_dir()
        .map(|path| packaged_stage(&path))
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

fn packaged_stage(resource_dir: &Path) -> PathBuf {
    // Node's entry-point resolver rejects ordinary Windows paths with a verbatim prefix.
    dunce::simplified(resource_dir).join(packaged_resource_directory())
}

fn packaged_resource_directory() -> &'static str {
    if cfg!(target_os = "windows") {
        "r"
    } else {
        "resources"
    }
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
    let stage_root = dunce::simplified(stage_root);
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

    #[test]
    fn keeps_the_windows_resource_container_short() {
        assert_eq!(
            packaged_resource_directory(),
            if cfg!(windows) { "r" } else { "resources" }
        );
    }

    #[cfg(windows)]
    #[test]
    fn packaged_paths_simplify_drive_paths_and_preserve_network_shares() {
        assert_eq!(
            packaged_stage(Path::new(r"\\?\C:\Program Files\DSH App")),
            PathBuf::from(r"C:\Program Files\DSH App\r")
        );
        assert_eq!(
            packaged_stage(Path::new(r"\\?\UNC\server\share\DSH App")),
            PathBuf::from(r"\\?\UNC\server\share\DSH App\r")
        );
    }

    #[cfg(windows)]
    #[test]
    fn node_starts_a_manager_entry_from_a_canonical_windows_resource_dir() {
        let temporary = tempfile::tempdir().unwrap();
        let resource_dir = temporary.path().join("DSH App with spaces");
        fs::create_dir_all(&resource_dir).unwrap();
        let canonical = fs::canonicalize(&resource_dir).unwrap();
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        let stage = packaged_stage(&canonical);
        let entry = stage.join("runtime-tools/dsh-runtime-manager.mjs");
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(&entry, "console.log('manager-started')\n").unwrap();
        let dirs = crate::user_dirs::UserDirs::from_home(&canonical).unwrap();
        let node = std::env::var_os("DSH_APP_TEST_NODE").unwrap_or_else(|| "node".into());
        let mut command = std::process::Command::new(node);
        command
            .arg(&entry)
            .current_dir(&dirs.workspace)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        crate::process::configure_background_process(&mut command);
        let output = command
            .output()
            .expect("Node is required for the Windows launch regression test");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "manager-started"
        );
    }
}
