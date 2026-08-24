use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::atomic::atomic_write;
use crate::error::LaunchError;

#[derive(Clone, Debug)]
pub struct UserDirs {
    pub root: PathBuf,
    pub profile: PathBuf,
    pub runtime: PathBuf,
    pub dsh: PathBuf,
    pub node: PathBuf,
    pub control: PathBuf,
    pub logs: PathBuf,
    pub workspace: PathBuf,
    pub config: PathBuf,
    pub window_state: PathBuf,
    pub patch: PathBuf,
    pub remote_plugins_state: PathBuf,
    pub pending_action: PathBuf,
}

impl UserDirs {
    pub fn resolve(app: &AppHandle) -> Result<Self, LaunchError> {
        let home = app.path().home_dir().map_err(|error| {
            LaunchError::new(
                "USER_DATA_DIR_NOT_WRITABLE",
                "The personal directory is unavailable",
                "DSH App could not resolve the current user's home directory.",
            )
            .detail("Underlying error", error.to_string())
        })?;
        Self::from_home(&home)
    }

    pub fn from_home(home: &Path) -> Result<Self, LaunchError> {
        let root = home.join(".dsh-app");
        let runtime = root.join("runtime");
        let dirs = Self {
            profile: root.join("profile"),
            dsh: runtime.join("dsh"),
            node: runtime.join("node"),
            control: runtime.join("control"),
            pending_action: runtime.join("pending-action.json"),
            runtime,
            logs: root.join("logs"),
            workspace: root.join("workspace"),
            config: root.join("config.json"),
            window_state: root.join("window-state.json"),
            patch: root.join("runtime/plugins.patch.json"),
            remote_plugins_state: root.join("runtime/remote-plugins.state.json"),
            root,
        };
        dirs.prepare()?;
        Ok(dirs)
    }

    fn prepare(&self) -> Result<(), LaunchError> {
        for path in [
            &self.root,
            &self.profile,
            &self.runtime,
            &self.node,
            &self.control,
            &self.logs,
            &self.workspace,
        ] {
            fs::create_dir_all(path).map_err(|error| data_dir_error(path, &error))?;
        }

        let probe = self
            .root
            .join(format!(".write-probe-{}", std::process::id()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)
            .map_err(|error| data_dir_error(&self.root, &error))?;
        file.write_all(b"dsh-app")
            .and_then(|_| file.sync_all())
            .map_err(|error| data_dir_error(&self.root, &error))?;
        drop(file);
        fs::remove_file(&probe).map_err(|error| data_dir_error(&self.root, &error))?;

        if !self.config.exists() {
            let data = serde_json::to_vec_pretty(&json!({ "schemaVersion": 1 }))
                .expect("static config is serializable");
            atomic_write(&self.config, &[data, b"\n".to_vec()].concat())
                .map_err(|error| data_dir_error(&self.config, &error))?;
        }
        Ok(())
    }
}

fn data_dir_error(path: &Path, error: &std::io::Error) -> LaunchError {
    LaunchError::new(
        "USER_DATA_DIR_NOT_WRITABLE",
        "The DSH App data directory is not writable",
        "Check the ownership and permissions of the personal DSH App directory.",
    )
    .detail("Path", path.display().to_string())
    .detail("Underlying error", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_all_user_data_under_the_external_root() {
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        assert_eq!(dirs.root, home.path().join(".dsh-app"));
        assert_eq!(dirs.profile, dirs.root.join("profile"));
        assert_eq!(dirs.patch, dirs.root.join("runtime/plugins.patch.json"));
        assert_eq!(
            dirs.remote_plugins_state,
            dirs.root.join("runtime/remote-plugins.state.json")
        );
        assert_eq!(dirs.dsh, dirs.root.join("runtime/dsh"));
        assert_eq!(dirs.node, dirs.root.join("runtime/node"));
        assert_eq!(dirs.window_state, dirs.root.join("window-state.json"));
        assert_eq!(
            dirs.pending_action,
            dirs.root.join("runtime/pending-action.json")
        );
        assert!(dirs.config.exists());
    }
}
