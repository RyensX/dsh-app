use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::atomic::atomic_write;
use crate::error::LaunchError;
use crate::model::{BootstrapManifest, LaunchStatus, RuntimeLayout};
use crate::node_check::{self, NodeIdentity};
use crate::runtime::{load_layout, resolve_packaged_runtime, resource_stage};
use crate::user_dirs::UserDirs;

const MANAGED_RUNTIME_BUILDER_VERSION: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeOrigin {
    Managed,
    Bundled,
}

#[derive(Clone, Debug)]
pub struct SelectedRuntime {
    pub layout: RuntimeLayout,
    pub origin: RuntimeOrigin,
    pending: Option<PendingAction>,
}

#[derive(Default)]
pub struct RemotePluginReport {
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePluginCatalogHeader {
    schema_version: u32,
    plugins: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePointer {
    schema_version: u32,
    runtime_id: String,
    commit: String,
    tag: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PendingAction {
    ActivateManaged {
        schema_version: u32,
        runtime_id: String,
        commit: String,
        tag: Option<String>,
    },
    RestoreManaged {
        schema_version: u32,
        runtime_id: String,
        commit: String,
        tag: Option<String>,
    },
    RestoreBundled {
        schema_version: u32,
    },
}

pub fn resolve(
    app: &AppHandle,
    dirs: &UserDirs,
    bootstrap: &BootstrapManifest,
    node: &Path,
    identity: &NodeIdentity,
) -> Result<SelectedRuntime, LaunchError> {
    let packaged = resolve_packaged_runtime(app)?;
    let pending = read_pending(dirs)?;

    if let Some(action) = &pending {
        match action {
            PendingAction::ActivateManaged { runtime_id, .. }
            | PendingAction::RestoreManaged { runtime_id, .. } => {
                if let Some(layout) =
                    load_managed(app, dirs, runtime_id, bootstrap, node, identity)?
                {
                    if matches!(action, PendingAction::RestoreManaged { .. }) {
                        prepare_restore_profile(app, dirs, node, &layout)?;
                    }
                    return Ok(SelectedRuntime {
                        layout,
                        origin: RuntimeOrigin::Managed,
                        pending,
                    });
                }
                clear_pending(dirs)?;
            }
            PendingAction::RestoreBundled { .. } => {
                #[cfg(feature = "bundled")]
                if let Some(layout) = packaged.clone() {
                    validate_bundled(&layout, bootstrap, node, identity)?;
                    prepare_restore_profile(app, dirs, node, &layout)?;
                    return Ok(SelectedRuntime {
                        layout,
                        origin: RuntimeOrigin::Bundled,
                        pending,
                    });
                }
                #[cfg(feature = "lite")]
                {
                    clear_pending(dirs)?;
                }
            }
        }
    }

    if let Some(pointer) = read_current(dirs)? {
        if let Some(layout) =
            load_managed(app, dirs, &pointer.runtime_id, bootstrap, node, identity)?
        {
            return Ok(SelectedRuntime {
                layout,
                origin: RuntimeOrigin::Managed,
                pending: None,
            });
        }
    }

    if let Some(layout) = packaged {
        validate_bundled(&layout, bootstrap, node, identity)?;
        return Ok(SelectedRuntime {
            layout,
            origin: RuntimeOrigin::Bundled,
            pending: None,
        });
    }

    install_baseline(app, dirs, bootstrap, node)?;
    let pointer = read_current(dirs)?.ok_or_else(|| {
        LaunchError::new(
            "DSH_RUNTIME_ASSEMBLY_FAILED",
            "The managed dsh runtime was not activated",
            "The runtime builder completed without publishing current.json.",
        )
    })?;
    let layout = load_managed(app, dirs, &pointer.runtime_id, bootstrap, node, identity)?
        .ok_or_else(|| {
            LaunchError::new(
                "DSH_RUNTIME_VERIFY_FAILED",
                "The managed dsh runtime is invalid",
                "Lite could not load the runtime it just built.",
            )
            .detail("Runtime ID", &pointer.runtime_id)
        })?;
    Ok(SelectedRuntime {
        layout,
        origin: RuntimeOrigin::Managed,
        pending: None,
    })
}

pub fn commit_pending(dirs: &UserDirs, selected: &SelectedRuntime) -> Result<(), LaunchError> {
    let Some(action) = &selected.pending else {
        return Ok(());
    };
    match action {
        PendingAction::ActivateManaged {
            runtime_id,
            commit,
            tag,
            ..
        } => {
            write_current(
                dirs,
                &RuntimePointer {
                    schema_version: 1,
                    runtime_id: runtime_id.clone(),
                    commit: commit.clone(),
                    tag: tag.clone(),
                },
            )?;
            clear_pending(dirs)
        }
        PendingAction::RestoreManaged {
            runtime_id,
            commit,
            tag,
            ..
        } => {
            write_current(
                dirs,
                &RuntimePointer {
                    schema_version: 1,
                    runtime_id: runtime_id.clone(),
                    commit: commit.clone(),
                    tag: tag.clone(),
                },
            )?;
            clear_pending(dirs)?;
            // Lite 的基线运行时必须保留；只清理源码、缓存和其他安装。
            cleanup_after_managed_restore(dirs, runtime_id);
            Ok(())
        }
        PendingAction::RestoreBundled { .. } => {
            #[cfg(all(feature = "lite", not(feature = "bundled")))]
            return Err(LaunchError::new(
                "RUNTIME_ACTION_NOT_ALLOWED",
                "Lite cannot restore an embedded dsh runtime",
                "Install the Bundled edition to use its embedded fallback.",
            ));
            #[cfg(all(feature = "bundled", not(feature = "lite")))]
            {
                let mut retired = None;
                if dirs.dsh.exists() {
                    let path = dirs
                        .runtime
                        .join(format!("dsh-restored-{}", std::process::id()));
                    let _ = fs::remove_dir_all(&path);
                    fs::rename(&dirs.dsh, &path).map_err(|error| {
                        LaunchError::io(
                            "DSH_RESTORE_FAILED",
                            "The downloaded dsh data could not be retired",
                            "The embedded runtime is ready, but external dsh data is still present.",
                            &error,
                        )
                    })?;
                    retired = Some(path);
                }
                if let Err(error) = clear_pending(dirs) {
                    if let Some(path) = &retired {
                        let _ = fs::rename(path, &dirs.dsh);
                    }
                    return Err(error);
                }
                // 内置运行时已就绪，可以删除全部外部 dsh 源码、安装与构建缓存。
                if let Some(path) = retired {
                    let _ = fs::remove_dir_all(path);
                }
                Ok(())
            }
            #[cfg(any(
                all(feature = "bundled", feature = "lite"),
                not(any(feature = "bundled", feature = "lite"))
            ))]
            unreachable!("Cargo feature validation failed")
        }
    }
}

pub fn rollback_failed_pending(dirs: &UserDirs) {
    match read_pending(dirs) {
        // 更新启动失败应回到旧运行时；还原失败则保留目标，让 Retry 继续完成还原。
        Ok(Some(PendingAction::ActivateManaged { .. })) | Err(_) => {
            let _ = fs::remove_file(&dirs.pending_action);
        }
        Ok(Some(PendingAction::RestoreManaged { .. } | PendingAction::RestoreBundled { .. }))
        | Ok(None) => {}
    }
}

pub fn runtime_manager_paths(app: &AppHandle) -> Result<RuntimeManagerPaths, LaunchError> {
    let stage = resource_stage(app)?;
    let paths = RuntimeManagerPaths {
        bootstrap: stage.join("bootstrap-manifest.json"),
        plugin_payload: stage.join("plugin-payload"),
        remote_plugins: stage.join("remote-plugins.json"),
        manager: stage.join("runtime-tools/dsh-runtime-manager.mjs"),
        corepack: stage.join("runtime-tools/corepack/dist/corepack.js"),
    };
    for path in [
        &paths.bootstrap,
        &paths.plugin_payload,
        &paths.remote_plugins,
        &paths.manager,
        &paths.corepack,
    ] {
        if !path.exists() {
            return Err(LaunchError::new(
                "RUNTIME_TOOLS_MISSING",
                "The dsh runtime manager is incomplete",
                "Reinstall DSH App from a verified installer.",
            )
            .detail("Missing path", path.display().to_string()));
        }
    }
    Ok(paths)
}

pub struct RuntimeManagerPaths {
    pub bootstrap: PathBuf,
    pub plugin_payload: PathBuf,
    pub remote_plugins: PathBuf,
    pub manager: PathBuf,
    pub corepack: PathBuf,
}

pub fn reconcile_remote_plugins(
    app: &AppHandle,
    dirs: &UserDirs,
    bootstrap: &BootstrapManifest,
    node: &Path,
    layout: &RuntimeLayout,
) -> Result<RemotePluginReport, LaunchError> {
    let tools = runtime_manager_paths(app)?;
    let source = fs::read_to_string(&tools.remote_plugins).map_err(|error| {
        LaunchError::io(
            "REMOTE_PLUGIN_CATALOG_INVALID",
            "The remote plugin catalog could not be read",
            "Reinstall DSH App from a verified installer.",
            &error,
        )
        .detail("Path", tools.remote_plugins.display().to_string())
    })?;
    let catalog: RemotePluginCatalogHeader = serde_json::from_str(&source).map_err(|error| {
        LaunchError::new(
            "REMOTE_PLUGIN_CATALOG_INVALID",
            "The remote plugin catalog is invalid",
            "Reinstall DSH App from a verified installer.",
        )
        .detail("Path", tools.remote_plugins.display().to_string())
        .detail("Underlying error", error.to_string())
    })?;
    if catalog.schema_version != 1 {
        return Err(LaunchError::new(
            "REMOTE_PLUGIN_CATALOG_INVALID",
            "The remote plugin catalog is unsupported",
            "Update DSH App before installing its remote plugins.",
        )
        .detail("Schema version", catalog.schema_version.to_string()));
    }
    if catalog.plugins.is_empty() {
        return Ok(RemotePluginReport::default());
    }

    let _ = app.emit(
        "dsh-status",
        LaunchStatus::Starting {
            message: "Preparing remote plugins...".into(),
        },
    );
    let output = Command::new(node)
        .arg(&tools.manager)
        .arg("reconcile-remote-plugins")
        .args(["--manifest"])
        .arg(&tools.remote_plugins)
        .args(["--profile"])
        .arg(&dirs.profile)
        .args(["--state"])
        .arg(&dirs.remote_plugins_state)
        .args(["--runtime-entry"])
        .arg(&layout.entry)
        .args(["--corepack"])
        .arg(&tools.corepack)
        .args(["--user-runtime"])
        .arg(&dirs.runtime)
        .args(["--target", &bootstrap.app.target])
        .args(["--edition", &bootstrap.app.edition])
        .args(["--dsh-commit", &layout.manifest.dsh.commit])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            LaunchError::io(
                "REMOTE_PLUGIN_INSTALL_FAILED",
                "The remote plugin installer could not be started",
                "No required remote plugin was activated.",
                &error,
            )
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(LaunchError::new(
            "REMOTE_PLUGIN_INSTALL_FAILED",
            "A required remote plugin could not be installed",
            "Check the network, package source, and install-script policy, then retry.",
        )
        .detail("Underlying error", bounded(&format!("{stdout}\n{stderr}"))));
    }

    let result = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|value| {
            value.get("type").and_then(|value| value.as_str()) == Some("result")
                && value.get("remotePlugins").is_some()
        })
        .ok_or_else(|| {
            LaunchError::new(
                "REMOTE_PLUGIN_INSTALL_FAILED",
                "The remote plugin installer returned an invalid result",
                "The dsh profile was not trusted for this launch.",
            )
        })?;
    let failures = result
        .get("remotePlugins")
        .and_then(|value| value.get("failures"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            LaunchError::new(
                "REMOTE_PLUGIN_INSTALL_FAILED",
                "The remote plugin installer returned an invalid report",
                "The dsh profile was not trusted for this launch.",
            )
        })?;
    let mut report = RemotePluginReport::default();
    for failure in failures {
        let name = failure
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let policy = failure
            .get("policy")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let message = failure
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("remote plugin installation failed");
        if policy == "required" {
            return Err(LaunchError::new(
                "REMOTE_PLUGIN_INSTALL_FAILED",
                "A required remote plugin could not be installed",
                "Check the package source and retry.",
            )
            .detail("Plugin", name)
            .detail("Underlying error", message));
        }
        report.warnings.push(format!("{name}: {message}"));
    }
    Ok(report)
}

fn install_baseline(
    app: &AppHandle,
    dirs: &UserDirs,
    bootstrap: &BootstrapManifest,
    node: &Path,
) -> Result<(), LaunchError> {
    let tools = runtime_manager_paths(app)?;
    let mut command = Command::new(node);
    command
        .arg(&tools.manager)
        .arg("install")
        .args(["--bootstrap"])
        .arg(&tools.bootstrap)
        .args(["--user-runtime"])
        .arg(&dirs.runtime)
        .args(["--plugin-payload"])
        .arg(&tools.plugin_payload)
        .args(["--corepack"])
        .arg(&tools.corepack)
        .args(["--commit", &bootstrap.dsh.commit])
        .args(["--activation", "current"])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("DSH_TELEMETRY_DISABLED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(tag) = &bootstrap.dsh.tag {
        command.args(["--tag", tag]);
    }
    let mut child = command.spawn().map_err(|error| {
        LaunchError::io(
            "DSH_BUILD_FAILED",
            "The dsh runtime builder could not be started",
            "Lite could not prepare its required dsh runtime.",
            &error,
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .expect("runtime manager stdout was piped");
    let stderr = child
        .stderr
        .take()
        .expect("runtime manager stderr was piped");
    let stderr_reader = thread::spawn(move || {
        let mut reader = stderr;
        let mut text = String::new();
        let _ = reader.read_to_string(&mut text);
        text
    });
    let mut recent = String::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        push_recent_output(&mut recent, &line, 16_000);
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if value.get("type").and_then(|value| value.as_str()) == Some("progress") {
                if let Some(message) = value.get("message").and_then(|value| value.as_str()) {
                    let _ = app.emit(
                        "dsh-status",
                        LaunchStatus::Starting {
                            message: message.to_owned(),
                        },
                    );
                }
            }
        }
    }
    let status = child.wait().map_err(|error| {
        LaunchError::io(
            "DSH_BUILD_FAILED",
            "The dsh runtime builder could not be monitored",
            "Retry the Lite bootstrap.",
            &error,
        )
    })?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(LaunchError::new(
            "DSH_BUILD_FAILED",
            "DeepSeek Harness could not be downloaded or compiled",
            "The previous runtime, if any, was left unchanged.",
        )
        .detail("Exit status", status.to_string())
        .detail("Builder output", bounded(&format!("{recent}\n{stderr}"))));
    }
    Ok(())
}

fn load_managed(
    app: &AppHandle,
    dirs: &UserDirs,
    runtime_id: &str,
    bootstrap: &BootstrapManifest,
    node: &Path,
    identity: &NodeIdentity,
) -> Result<Option<RuntimeLayout>, LaunchError> {
    if !valid_runtime_id(runtime_id) {
        return Ok(None);
    }
    let root = dirs.dsh.join("installs").join(runtime_id);
    let Ok(layout) = load_layout(&root) else {
        return Ok(None);
    };
    if !managed_runtime_compatible(&layout, bootstrap, node, identity) {
        return Ok(None);
    }
    if layout.manifest.plugin_digest == bootstrap.plugin_digest {
        return Ok(Some(layout));
    }

    // App 插件不是 dsh 编译产物的兼容性条件；只在本地刷新插件，不触发 Git 或编译。
    refresh_managed_plugins(app, dirs, bootstrap, node, runtime_id)?;
    let refreshed = load_layout(&root)?;
    if !managed_runtime_compatible(&refreshed, bootstrap, node, identity)
        || refreshed.manifest.plugin_digest != bootstrap.plugin_digest
    {
        return Err(LaunchError::new(
            "APP_PLUGIN_REFRESH_FAILED",
            "The App plugins could not be refreshed",
            "The existing compiled dsh runtime was preserved, but its App plugins are still incompatible.",
        )
        .detail("Runtime ID", runtime_id));
    }
    Ok(Some(refreshed))
}

fn managed_runtime_compatible(
    layout: &RuntimeLayout,
    bootstrap: &BootstrapManifest,
    node: &Path,
    identity: &NodeIdentity,
) -> bool {
    layout.manifest.builder_version == Some(MANAGED_RUNTIME_BUILDER_VERSION)
        && layout.manifest.app.edition == "managed"
        && layout.manifest.app.target == bootstrap.app.target
        && node_check::validate_runtime(node, identity, layout).is_ok()
}

fn prepare_restore_profile(
    app: &AppHandle,
    dirs: &UserDirs,
    node: &Path,
    layout: &RuntimeLayout,
) -> Result<(), LaunchError> {
    let credentials_layout = layout
        .manifest
        .dsh
        .credentials_layout
        .as_deref()
        .or_else(|| inferred_credentials_layout(layout.manifest.dsh.version.as_deref()))
        .ok_or_else(|| {
            LaunchError::new(
                "RESTORE_PROFILE_COMPATIBILITY_MISSING",
                "The restore target has no profile compatibility metadata",
                "Rebuild the App baseline runtime before restoring it.",
            )
        })?;
    if credentials_layout == "versioned-v1" {
        return Ok(());
    }
    if credentials_layout != "flat-v0" {
        return Err(LaunchError::new(
            "RESTORE_PROFILE_COMPATIBILITY_MISSING",
            "The restore target uses an unsupported credentials layout",
            "Update DSH App before restoring this runtime.",
        )
        .detail("Credentials layout", credentials_layout));
    }

    let tools = runtime_manager_paths(app)?;
    let output = Command::new(node)
        .arg(&tools.manager)
        .arg("prepare-restore-profile")
        .args(["--profile"])
        .arg(&dirs.profile)
        .args(["--credentials-layout", credentials_layout])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            LaunchError::io(
                "RESTORE_PROFILE_PREPARE_FAILED",
                "The dsh profile could not be prepared for restore",
                "The original credentials file was left unchanged.",
                &error,
            )
        })?;
    if !output.status.success() {
        return Err(LaunchError::new(
            "RESTORE_PROFILE_PREPARE_FAILED",
            "The dsh profile could not be prepared for restore",
            "The original credentials file was left unchanged or backed up before conversion.",
        )
        .detail(
            "Underlying error",
            bounded(&String::from_utf8_lossy(&output.stderr)),
        ));
    }
    let result_matches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|value| {
            value.get("type").and_then(|value| value.as_str()) == Some("result")
                && value
                    .get("credentialsLayout")
                    .and_then(|value| value.as_str())
                    == Some(credentials_layout)
        });
    if !result_matches {
        return Err(LaunchError::new(
            "RESTORE_PROFILE_PREPARE_FAILED",
            "The dsh profile preparer returned an invalid result",
            "The restore target was not started.",
        ));
    }
    Ok(())
}

fn inferred_credentials_layout(version: Option<&str>) -> Option<&'static str> {
    // builder v2 的既有安装没有显式元数据；仅为已发布过的两个已知布局提供迁移桥接。
    match version {
        Some("0.1.0-rc.7") => Some("flat-v0"),
        Some("0.1.1-rc.1") => Some("versioned-v1"),
        _ => None,
    }
}

fn refresh_managed_plugins(
    app: &AppHandle,
    dirs: &UserDirs,
    bootstrap: &BootstrapManifest,
    node: &Path,
    runtime_id: &str,
) -> Result<(), LaunchError> {
    let tools = runtime_manager_paths(app)?;
    let output = Command::new(node)
        .arg(&tools.manager)
        .arg("refresh-plugins")
        .args(["--bootstrap"])
        .arg(&tools.bootstrap)
        .args(["--user-runtime"])
        .arg(&dirs.runtime)
        .args(["--plugin-payload"])
        .arg(&tools.plugin_payload)
        .args(["--runtime-id", runtime_id])
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| {
            LaunchError::io(
                "APP_PLUGIN_REFRESH_FAILED",
                "The App plugin refresher could not be started",
                "The existing compiled dsh runtime was left unchanged.",
                &error,
            )
        })?;
    if !output.status.success() {
        return Err(LaunchError::new(
            "APP_PLUGIN_REFRESH_FAILED",
            "The App plugins could not be refreshed",
            "The existing compiled dsh runtime was preserved; review diagnostics for the exact refresh failure.",
        )
        .detail("Runtime ID", runtime_id)
        .detail("Underlying error", bounded(&String::from_utf8_lossy(&output.stderr))));
    }
    let result_matches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|value| {
            value.get("type").and_then(|value| value.as_str()) == Some("result")
                && value.get("runtimeId").and_then(|value| value.as_str()) == Some(runtime_id)
                && value.get("pluginDigest").and_then(|value| value.as_str())
                    == Some(bootstrap.plugin_digest.as_str())
        });
    if !result_matches {
        return Err(LaunchError::new(
            "APP_PLUGIN_REFRESH_FAILED",
            "The App plugin refresher returned an invalid result",
            "The existing compiled dsh runtime was preserved.",
        )
        .detail("Runtime ID", runtime_id));
    }
    Ok(())
}

fn validate_bundled(
    layout: &RuntimeLayout,
    bootstrap: &BootstrapManifest,
    node: &Path,
    identity: &NodeIdentity,
) -> Result<(), LaunchError> {
    if layout.manifest.app.edition != "bundled"
        || layout.manifest.app.target != bootstrap.app.target
        || layout.manifest.app.version != bootstrap.app.version
        || layout.manifest.plugin_digest != bootstrap.plugin_digest
    {
        return Err(LaunchError::new(
            "RUNTIME_IDENTITY_MISMATCH",
            "The embedded dsh runtime does not match this application",
            "Rebuild or reinstall the Bundled edition.",
        ));
    }
    let bundled_node = layout.manifest.bundled_node.as_ref().ok_or_else(|| {
        LaunchError::new(
            "BUNDLED_NODE_MISSING",
            "The embedded dsh runtime has no Node provenance",
            "Rebuild or reinstall the Bundled edition.",
        )
    })?;
    if bundled_node.version != bootstrap.node.version
        || bundled_node.archive != bootstrap.node.archive
        || bundled_node.sha256 != bootstrap.node.sha256
    {
        return Err(LaunchError::new(
            "BUNDLED_NODE_MISSING",
            "The embedded Node provenance does not match this runtime",
            "Rebuild or reinstall the Bundled edition.",
        ));
    }
    node_check::validate_runtime(node, identity, layout)
}

fn read_current(dirs: &UserDirs) -> Result<Option<RuntimePointer>, LaunchError> {
    read_json_if_present(&dirs.dsh.join("current.json"))
}

fn read_pending(dirs: &UserDirs) -> Result<Option<PendingAction>, LaunchError> {
    read_json_if_present(&dirs.pending_action)
}

fn read_json_if_present<T: for<'de> Deserialize<'de>>(
    path: &Path,
) -> Result<Option<T>, LaunchError> {
    if !path.exists() {
        return Ok(None);
    }
    let source = fs::read_to_string(path).map_err(|error| {
        LaunchError::io(
            "RUNTIME_STATE_INVALID",
            "The dsh runtime state could not be read",
            "Check the permissions of ~/.dsh-app/runtime.",
            &error,
        )
        .detail("Path", path.display().to_string())
    })?;
    serde_json::from_str(&source).map(Some).map_err(|error| {
        LaunchError::new(
            "RUNTIME_STATE_INVALID",
            "The dsh runtime state is invalid",
            "Remove the invalid state file or retry from the Bundled fallback.",
        )
        .detail("Path", path.display().to_string())
        .detail("Underlying error", error.to_string())
    })
}

fn write_current(dirs: &UserDirs, pointer: &RuntimePointer) -> Result<(), LaunchError> {
    let mut data = serde_json::to_vec_pretty(pointer).expect("runtime pointer is serializable");
    data.push(b'\n');
    atomic_write(&dirs.dsh.join("current.json"), &data).map_err(|error| {
        LaunchError::io(
            "RUNTIME_STATE_INVALID",
            "The active dsh runtime could not be recorded",
            "The downloaded runtime remains installed but is not active.",
            &error,
        )
    })
}

fn clear_pending(dirs: &UserDirs) -> Result<(), LaunchError> {
    match fs::remove_file(&dirs.pending_action) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(LaunchError::io(
            "RUNTIME_STATE_INVALID",
            "The pending dsh action could not be cleared",
            "Check the permissions of ~/.dsh-app/runtime.",
            &error,
        )),
    }
}

fn cleanup_after_managed_restore(dirs: &UserDirs, active_runtime_id: &str) {
    if !valid_runtime_id(active_runtime_id) {
        return;
    }
    for directory in ["source", "cache", "staging"] {
        let _ = fs::remove_dir_all(dirs.dsh.join(directory));
    }
    let installs = dirs.dsh.join("installs");
    let Ok(entries) = fs::read_dir(&installs) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() == active_runtime_id {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else {
            let _ = fs::remove_file(path);
        }
    }
    let _ = fs::remove_file(dirs.dsh.join("install.lock"));
}

fn valid_runtime_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded(value: &str) -> String {
    let safe = value
        .lines()
        .map(|line| {
            let upper = line.to_ascii_uppercase();
            if [
                "API_KEY",
                "PASSWORD",
                "SECRET",
                "ACCESS_TOKEN",
                "AUTHORIZATION",
            ]
            .iter()
            .any(|marker| upper.contains(marker))
            {
                "[redacted sensitive output]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let chars = safe.chars().collect::<Vec<_>>();
    if chars.len() > 8000 {
        chars[chars.len() - 8000..].iter().collect()
    } else {
        safe
    }
}

fn push_recent_output(output: &mut String, line: &str, max_bytes: usize) {
    output.push_str(line);
    output.push('\n');
    if output.len() <= max_bytes {
        return;
    }

    // String 索引是 UTF-8 字节位置；裁剪点必须前移到合法字符边界。
    let mut start = output.len() - max_bytes;
    while !output.is_char_boundary(start) {
        start += 1;
    }
    output.drain(..start);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_ids_are_contained_hashes() {
        assert!(valid_runtime_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_runtime_id("../runtime"));
        assert!(!valid_runtime_id("ABCDEF0123456789abcdef0123456789"));
    }

    #[test]
    fn recent_output_trimming_never_splits_utf8() {
        let mut output = format!("✓{}", "a".repeat(15_997));
        push_recent_output(&mut output, "", 16_000);
        assert!(output.len() <= 16_000);
        assert!(output.starts_with('a'));
    }

    #[test]
    fn managed_restore_keeps_only_the_active_baseline_install() {
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let active = "0123456789abcdef0123456789abcdef";
        let retired = "abcdef0123456789abcdef0123456789";
        for path in [
            dirs.dsh.join("source"),
            dirs.dsh.join("cache"),
            dirs.dsh.join("staging"),
            dirs.dsh.join("installs").join(active),
            dirs.dsh.join("installs").join(retired),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(dirs.dsh.join("install.lock"), "locked").unwrap();

        cleanup_after_managed_restore(&dirs, active);

        assert!(dirs.dsh.join("installs").join(active).is_dir());
        assert!(!dirs.dsh.join("installs").join(retired).exists());
        assert!(!dirs.dsh.join("source").exists());
        assert!(!dirs.dsh.join("cache").exists());
        assert!(!dirs.dsh.join("staging").exists());
        assert!(!dirs.dsh.join("install.lock").exists());
    }

    #[test]
    fn parses_managed_restore_pending_actions() {
        let action: PendingAction = serde_json::from_str(&format!(
            r#"{{"schemaVersion":1,"action":"restoreManaged","runtimeId":"{}","commit":"{}","tag":"dsh-v1.0.0"}}"#,
            "0".repeat(32),
            "a".repeat(40),
        ))
        .unwrap();
        assert!(matches!(action, PendingAction::RestoreManaged { .. }));
    }

    #[test]
    fn failed_launch_rolls_back_updates_but_keeps_restore_actions() {
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let update = format!(
            r#"{{"schemaVersion":1,"action":"activateManaged","runtimeId":"{}","commit":"{}","tag":null}}"#,
            "0".repeat(32),
            "a".repeat(40),
        );
        fs::write(&dirs.pending_action, update).unwrap();
        rollback_failed_pending(&dirs);
        assert!(!dirs.pending_action.exists());

        let restore = format!(
            r#"{{"schemaVersion":1,"action":"restoreManaged","runtimeId":"{}","commit":"{}","tag":null}}"#,
            "0".repeat(32),
            "a".repeat(40),
        );
        fs::write(&dirs.pending_action, &restore).unwrap();
        rollback_failed_pending(&dirs);
        assert_eq!(fs::read_to_string(&dirs.pending_action).unwrap(), restore);

        fs::write(
            &dirs.pending_action,
            r#"{"schemaVersion":1,"action":"restoreBundled"}"#,
        )
        .unwrap();
        rollback_failed_pending(&dirs);
        assert!(dirs.pending_action.exists());
    }

    #[test]
    fn infers_credentials_layout_only_for_known_builder_two_runtimes() {
        assert_eq!(
            inferred_credentials_layout(Some("0.1.0-rc.7")),
            Some("flat-v0")
        );
        assert_eq!(
            inferred_credentials_layout(Some("0.1.1-rc.1")),
            Some("versioned-v1")
        );
        assert_eq!(inferred_credentials_layout(Some("0.2.0")), None);
        assert_eq!(inferred_credentials_layout(None), None);
    }
}
