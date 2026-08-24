use node_semver::{Range, Version};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::atomic::atomic_write;
use crate::error::LaunchError;
use crate::model::BootstrapManifest;
use crate::user_dirs::UserDirs;

pub const NODE_NOT_EXECUTABLE: &str = "NODE_NOT_EXECUTABLE";
pub const NODE_VERSION_UNSUPPORTED: &str = "NODE_VERSION_UNSUPPORTED";
pub const NODE_ARCH_MISMATCH: &str = "NODE_ARCH_MISMATCH";
pub const NODE_PREFLIGHT_TIMEOUT: &str = "NODE_PREFLIGHT_TIMEOUT";
pub const DSH_PREFLIGHT_FAILED: &str = "DSH_PREFLIGHT_FAILED";
pub const NODE_DOWNLOAD_FAILED: &str = "NODE_DOWNLOAD_FAILED";
pub const NODE_CHECKSUM_MISMATCH: &str = "NODE_CHECKSUM_MISMATCH";
pub const NODE_INSTALL_FAILED: &str = "NODE_INSTALL_FAILED";

const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiteNodeConfig {
    schema_version: u32,
    node_path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct NodeProbe {
    version: String,
    platform: String,
    arch: String,
}

struct CapturedOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

pub fn set_configured_path(
    _app: &AppHandle,
    dirs: &UserDirs,
    path: &str,
) -> Result<(), LaunchError> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(node_path_error(
            NODE_NOT_EXECUTABLE,
            "The selected Node path is not absolute",
            &path,
            "Choose the Node executable itself, not a shell alias or command name.",
        ));
    }
    validate_executable(&path)?;
    let config = LiteNodeConfig {
        schema_version: 1,
        node_path: path,
    };
    let mut data = serde_json::to_vec_pretty(&config).map_err(|error| {
        LaunchError::new(
            DSH_PREFLIGHT_FAILED,
            "The Lite Node configuration could not be encoded",
            "DSH App did not change the selected Node executable.",
        )
        .detail("Underlying error", error.to_string())
    })?;
    data.push(b'\n');
    let config_path = config_path(dirs);
    atomic_write(&config_path, &data).map_err(|error| {
        LaunchError::io(
            "USER_DATA_DIR_NOT_WRITABLE",
            "The Lite Node configuration is not writable",
            "Check the ownership and permissions of the DSH App personal directory.",
            &error,
        )
        .detail("Path", config_path.display().to_string())
    })
}

/// Resolve a compatible system Node first, then reuse or download Lite's managed fallback.
pub fn resolve_for_bootstrap(
    dirs: &UserDirs,
    bootstrap: &BootstrapManifest,
) -> Result<PathBuf, LaunchError> {
    let mut candidates = Vec::new();
    if let Some(configured) = configured_candidate(dirs)? {
        candidates.push(configured);
    }
    candidates.extend(discovered_candidates(&dirs.root));
    candidates.push(managed_node_path(dirs, bootstrap));

    let mut seen = HashSet::new();
    let mut rejected = Vec::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) || !candidate.is_file() {
            continue;
        }
        match compatible_candidate(&candidate, bootstrap) {
            Ok(node) => return Ok(node),
            Err(error) => rejected.push(format!("{}: {}", candidate.display(), error.message)),
        }
    }

    download_managed_node(dirs, bootstrap).map_err(|error| {
        if rejected.is_empty() {
            error
        } else {
            error.detail("Rejected Node installations", rejected.join("\n"))
        }
    })
}

fn configured_candidate(dirs: &UserDirs) -> Result<Option<PathBuf>, LaunchError> {
    let path = config_path(dirs);
    if !path.exists() {
        return Ok(None);
    }
    let source = fs::read_to_string(&path).map_err(|error| {
        node_path_error(
            NODE_NOT_EXECUTABLE,
            "The configured Lite Node path could not be read",
            &path,
            &error.to_string(),
        )
    })?;
    let config: LiteNodeConfig = serde_json::from_str(&source).map_err(|error| {
        node_path_error(
            NODE_NOT_EXECUTABLE,
            "The configured Lite Node path is invalid",
            &path,
            &error.to_string(),
        )
    })?;
    if config.schema_version != 1 || !config.node_path.is_absolute() {
        return Err(node_path_error(
            NODE_NOT_EXECUTABLE,
            "The configured Lite Node path is invalid",
            &config.node_path,
            "lite.json must use schemaVersion 1 and an absolute nodePath.",
        ));
    }
    Ok(Some(config.node_path))
}

fn compatible_candidate(
    candidate: &Path,
    bootstrap: &BootstrapManifest,
) -> Result<PathBuf, LaunchError> {
    validate_executable(candidate)?;
    let node = fs::canonicalize(candidate).map_err(|error| {
        node_path_error(
            NODE_NOT_EXECUTABLE,
            "The detected Node path cannot be resolved",
            candidate,
            &error.to_string(),
        )
    })?;
    let probe = probe_node(&node)?;
    validate_bootstrap_probe(&node, &probe, bootstrap)?;
    Ok(node)
}

fn validate_bootstrap_probe(
    node: &Path,
    probe: &NodeProbe,
    bootstrap: &BootstrapManifest,
) -> Result<(), LaunchError> {
    let range = Range::parse(&bootstrap.dsh.node_engine).map_err(|error| {
        LaunchError::new(
            DSH_PREFLIGHT_FAILED,
            "The dsh Node requirement is invalid",
            "The application bootstrap manifest cannot be evaluated.",
        )
        .detail("Required Node", &bootstrap.dsh.node_engine)
        .detail("Underlying error", error.to_string())
    })?;
    let version = Version::parse(&probe.version).map_err(|error| {
        node_path_error(
            NODE_VERSION_UNSUPPORTED,
            "The detected Node version is invalid",
            node,
            &error.to_string(),
        )
    })?;
    if !range.satisfies(&version) {
        return Err(LaunchError::new(
            NODE_VERSION_UNSUPPORTED,
            "The detected Node version is not supported",
            "Lite will use a compatible managed Node instead.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Detected version", format!("v{}", probe.version))
        .detail("Required version", &bootstrap.dsh.node_engine));
    }
    if probe.platform != bootstrap.node.platform || probe.arch != bootstrap.node.arch {
        return Err(LaunchError::new(
            NODE_ARCH_MISMATCH,
            "The detected Node architecture does not match DSH App",
            "Lite will use a managed Node built for this application target.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Detected", format!("{}/{}", probe.platform, probe.arch))
        .detail(
            "Required",
            format!("{}/{}", bootstrap.node.platform, bootstrap.node.arch),
        ));
    }
    Ok(())
}

fn managed_node_path(dirs: &UserDirs, bootstrap: &BootstrapManifest) -> PathBuf {
    let root = dirs.node.join(&bootstrap.node.version).join(format!(
        "{}-{}",
        bootstrap.node.platform, bootstrap.node.arch
    ));
    if cfg!(windows) {
        root.join("node.exe")
    } else {
        root.join("bin/node")
    }
}

fn download_managed_node(
    dirs: &UserDirs,
    bootstrap: &BootstrapManifest,
) -> Result<PathBuf, LaunchError> {
    let final_node = managed_node_path(dirs, bootstrap);
    let final_root = if cfg!(windows) {
        final_node.parent()
    } else {
        final_node.parent().and_then(Path::parent)
    }
    .ok_or_else(|| {
        LaunchError::new(
            NODE_INSTALL_FAILED,
            "The managed Node destination is invalid",
            "Lite could not derive its external Node installation directory.",
        )
    })?;
    let parent = final_root.parent().ok_or_else(|| {
        LaunchError::new(
            NODE_INSTALL_FAILED,
            "The managed Node destination is invalid",
            "Lite could not derive its external Node installation parent.",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        LaunchError::io(
            NODE_INSTALL_FAILED,
            "The managed Node directory is not writable",
            "Check the permissions of ~/.dsh-app/runtime/node.",
            &error,
        )
    })?;
    let temporary = parent.join(format!(".install-{}", std::process::id()));
    let _ = fs::remove_dir_all(&temporary);
    fs::create_dir_all(&temporary).map_err(|error| {
        LaunchError::io(
            NODE_INSTALL_FAILED,
            "The managed Node staging directory is not writable",
            "Lite could not prepare the Node download.",
            &error,
        )
    })?;

    let result = (|| {
        let archive = temporary.join(&bootstrap.node.archive);
        let url = format!(
            "{}/v{}/{}",
            bootstrap.node.base_url.trim_end_matches('/'),
            bootstrap.node.version,
            bootstrap.node.archive
        );
        let response = ureq::get(&url).call().map_err(|error| {
            LaunchError::new(
                NODE_DOWNLOAD_FAILED,
                "Lite could not download Node",
                "Check the network connection or install the Bundled edition.",
            )
            .detail("URL", &url)
            .detail("Underlying error", error.to_string())
        })?;
        let mut input = response.into_reader();
        let mut output = File::create(&archive).map_err(|error| {
            LaunchError::io(
                NODE_INSTALL_FAILED,
                "The Node archive could not be created",
                "Check the Lite runtime directory permissions.",
                &error,
            )
        })?;
        io::copy(&mut input, &mut output).map_err(|error| {
            LaunchError::io(
                NODE_DOWNLOAD_FAILED,
                "The Node download could not be saved",
                "Retry after checking free disk space and permissions.",
                &error,
            )
        })?;
        let actual = sha256_file(&archive)?;
        if actual != bootstrap.node.sha256 {
            return Err(LaunchError::new(
                NODE_CHECKSUM_MISMATCH,
                "The downloaded Node archive failed verification",
                "Lite refused to execute a Node archive that does not match the signed manifest.",
            )
            .detail("Expected SHA256", &bootstrap.node.sha256)
            .detail("Actual SHA256", actual));
        }

        let extracted = temporary.join("extracted");
        fs::create_dir_all(&extracted).map_err(|error| {
            LaunchError::io(
                NODE_INSTALL_FAILED,
                "The Node archive could not be extracted",
                "Lite could not prepare the extraction directory.",
                &error,
            )
        })?;
        extract_node_archive(&archive, &extracted)?;
        let source_root = single_extracted_directory(&extracted)?;
        if final_root.exists() {
            fs::remove_dir_all(final_root).map_err(|error| {
                LaunchError::io(
                    NODE_INSTALL_FAILED,
                    "The previous managed Node could not be replaced",
                    "Close other DSH App instances and retry.",
                    &error,
                )
            })?;
        }
        fs::rename(&source_root, final_root).map_err(|error| {
            LaunchError::io(
                NODE_INSTALL_FAILED,
                "The managed Node installation could not be published",
                "Lite left the existing Node selection unchanged.",
                &error,
            )
        })?;
        compatible_candidate(&final_node, bootstrap)
    })();
    let _ = fs::remove_dir_all(&temporary);
    result
}

fn sha256_file(path: &Path) -> Result<String, LaunchError> {
    let mut file = File::open(path).map_err(|error| {
        LaunchError::io(
            NODE_INSTALL_FAILED,
            "The downloaded Node archive could not be read",
            "Lite could not verify the downloaded archive.",
            &error,
        )
    })?;
    let mut hash = Sha256::new();
    io::copy(&mut file, &mut hash).map_err(|error| {
        LaunchError::io(
            NODE_INSTALL_FAILED,
            "The downloaded Node archive could not be hashed",
            "Lite could not verify the downloaded archive.",
            &error,
        )
    })?;
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(not(windows))]
fn extract_node_archive(archive: &Path, destination: &Path) -> Result<(), LaunchError> {
    let file = File::open(archive).map_err(|error| node_install_io(archive, &error))?;
    let decoder = flate2::read::GzDecoder::new(file);
    tar::Archive::new(decoder)
        .unpack(destination)
        .map_err(|error| node_install_io(destination, &error))
}

#[cfg(windows)]
fn extract_node_archive(archive: &Path, destination: &Path) -> Result<(), LaunchError> {
    let file = File::open(archive).map_err(|error| node_install_io(archive, &error))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| {
        LaunchError::new(
            NODE_INSTALL_FAILED,
            "The Node ZIP archive is invalid",
            "Lite could not extract the managed Node distribution.",
        )
        .detail("Underlying error", error.to_string())
    })?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| {
            LaunchError::new(
                NODE_INSTALL_FAILED,
                "The Node ZIP archive is invalid",
                "Lite could not read an archive entry.",
            )
            .detail("Underlying error", error.to_string())
        })?;
        let Some(name) = entry.enclosed_name() else {
            return Err(LaunchError::new(
                NODE_INSTALL_FAILED,
                "The Node ZIP archive contains an unsafe path",
                "Lite refused to extract an entry outside its managed directory.",
            ));
        };
        let output = destination.join(name);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| node_install_io(&output, &error))?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|error| node_install_io(parent, &error))?;
            }
            let mut file =
                File::create(&output).map_err(|error| node_install_io(&output, &error))?;
            io::copy(&mut entry, &mut file).map_err(|error| node_install_io(&output, &error))?;
        }
    }
    Ok(())
}

fn node_install_io(path: &Path, error: &io::Error) -> LaunchError {
    LaunchError::io(
        NODE_INSTALL_FAILED,
        "The managed Node archive could not be extracted",
        "Lite could not install the downloaded Node distribution.",
        error,
    )
    .detail("Path", path.display().to_string())
}

fn single_extracted_directory(root: &Path) -> Result<PathBuf, LaunchError> {
    let entries = fs::read_dir(root)
        .map_err(|error| node_install_io(root, &error))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    if entries.len() != 1 {
        return Err(LaunchError::new(
            NODE_INSTALL_FAILED,
            "The Node archive layout is invalid",
            "The official archive did not contain exactly one distribution directory.",
        )
        .detail("Directory count", entries.len().to_string()));
    }
    Ok(entries[0].path())
}

fn config_path(dirs: &UserDirs) -> PathBuf {
    dirs.root.join("lite.json")
}

fn discovered_candidates(_user_root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            paths.push(directory.join(node_filename()));
        }
    }

    if let Some(home) = home_from_environment() {
        #[cfg(target_os = "macos")]
        {
            paths.push(PathBuf::from("/opt/homebrew/bin/node"));
            paths.push(PathBuf::from("/usr/local/bin/node"));
            paths.push(PathBuf::from("/usr/bin/node"));
            paths.push(home.join(".volta/bin/node"));
            append_versioned(&mut paths, &home.join(".nvm/versions/node"), "bin/node");
            append_versioned(
                &mut paths,
                &home.join(".fnm/node-versions"),
                "installation/bin/node",
            );
            append_versioned(
                &mut paths,
                &home.join("Library/Application Support/fnm/node-versions"),
                "installation/bin/node",
            );
        }
        #[cfg(windows)]
        {
            paths.push(home.join(".volta/bin/node.exe"));
        }
    }

    #[cfg(windows)]
    {
        for variable in ["ProgramFiles", "LOCALAPPDATA", "NVM_SYMLINK"] {
            if let Some(root) = env::var_os(variable).map(PathBuf::from) {
                paths.push(if variable == "NVM_SYMLINK" {
                    root.join("node.exe")
                } else if variable == "LOCALAPPDATA" {
                    root.join("Programs/nodejs/node.exe")
                } else {
                    root.join("nodejs/node.exe")
                });
            }
        }
    }

    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn append_versioned(paths: &mut Vec<PathBuf>, root: &Path, suffix: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    versions.sort_by(|left, right| right.cmp(left));
    paths.extend(versions.into_iter().map(|path| path.join(suffix)));
}

fn home_from_environment() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    env::var_os(key).map(PathBuf::from)
}

fn node_filename() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn validate_executable(path: &Path) -> Result<(), LaunchError> {
    let metadata = fs::metadata(path).map_err(|error| {
        node_path_error(
            NODE_NOT_EXECUTABLE,
            "The Node executable is unavailable",
            path,
            &error.to_string(),
        )
    })?;
    if !metadata.is_file() {
        return Err(node_path_error(
            NODE_NOT_EXECUTABLE,
            "The Node path is not a file",
            path,
            "Choose the Node executable itself.",
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(node_path_error(
            NODE_NOT_EXECUTABLE,
            "The Node file is not executable",
            path,
            "Grant execute permission or choose another Node installation.",
        ));
    }
    Ok(())
}

fn probe_node(node: &Path) -> Result<NodeProbe, LaunchError> {
    const SCRIPT: &str = r#"process.stdout.write(JSON.stringify({version:process.version.slice(1),abi:String(process.versions.modules||''),platform:process.platform,arch:process.arch}))"#;
    probe_node_with_script(node, SCRIPT, NODE_PROBE_TIMEOUT)
}

fn probe_node_with_script(
    node: &Path,
    script: &str,
    timeout: Duration,
) -> Result<NodeProbe, LaunchError> {
    let mut command = Command::new(node);
    command.args(["-e", script]);
    clean_node_injection(&mut command);
    let output = capture_with_timeout(&mut command, timeout).map_err(|error| {
        node_path_error(
            NODE_NOT_EXECUTABLE,
            "The Node executable could not be launched",
            node,
            &error.to_string(),
        )
    })?;
    if output.timed_out {
        return Err(node_probe_timeout(
            node,
            "Node did not report its version within 5 seconds.",
        ));
    }
    if !output.status.success() {
        return Err(node_path_error(
            NODE_NOT_EXECUTABLE,
            "The Node executable failed its identity probe",
            node,
            &bounded_reason(&output),
        ));
    }
    serde_json::from_str(&output.stdout).map_err(|error| {
        node_path_error(
            NODE_NOT_EXECUTABLE,
            "The executable did not return a valid Node identity",
            node,
            &error.to_string(),
        )
    })
}

fn capture_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<CapturedOutput> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));
    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status, false);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            break (child.wait()?, true);
        }
        thread::sleep(Duration::from_millis(40));
    };
    let stdout = stdout_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?;
    let stderr = stderr_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?;
    Ok(CapturedOutput {
        status,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
    })
}

fn read_all(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn clean_node_injection(command: &mut Command) {
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
}

fn bounded_reason(output: &CapturedOutput) -> String {
    let source = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    let safe = source
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
    let chars: Vec<char> = safe.chars().collect();
    if chars.len() > 4000 {
        chars[chars.len() - 4000..].iter().collect()
    } else if safe.is_empty() {
        format!("process exited with {}", output.status)
    } else {
        safe
    }
}

fn node_path_error(code: &str, title: &str, path: &Path, reason: &str) -> LaunchError {
    LaunchError::new(
        code,
        title,
        "Choose another Node executable or use the Bundled edition.",
    )
    .detail("Node path", path.display().to_string())
    .detail("Underlying error", reason)
}

fn node_probe_timeout(node: &Path, reason: &str) -> LaunchError {
    LaunchError::new(
        NODE_PREFLIGHT_TIMEOUT,
        "The system Node preflight timed out",
        "The selected Node installation did not complete a required check in time.",
    )
    .detail("Node path", node.display().to_string())
    .detail("Underlying error", reason)
}

#[cfg(any())]
fn native_error(
    node: &Path,
    probe: &NodeProbe,
    layout: &RuntimeLayout,
    reason: &str,
) -> LaunchError {
    LaunchError::new(
        NODE_NATIVE_MODULE_INCOMPATIBLE,
        "The system Node cannot load dsh native modules",
        "Use a compatible Node build or install the Bundled edition.",
    )
    .detail("Node path", node.display().to_string())
    .detail("Detected version", format!("v{}", probe.version))
    .detail("Required version", &layout.manifest.dsh.node_engine)
    .detail("Detected ABI", &probe.abi)
    .detail("Build ABI", &layout.manifest.native.node_abi)
    .detail(
        "Detected platform",
        format!("{}/{}", probe.platform, probe.arch),
    )
    .detail("Underlying error", reason)
}

#[cfg(any())]
mod tests {
    use super::*;
    use crate::model::{AppManifest, DshManifest, NativeManifest, RuntimeManifest};

    fn installed_node() -> PathBuf {
        let path = env::var_os("PATH").expect("Lite Node tests require PATH");
        env::split_paths(&path)
            .map(|directory| directory.join(node_filename()))
            .find(|candidate| candidate.is_file())
            .and_then(|candidate| fs::canonicalize(candidate).ok())
            .expect("Lite Node tests require Node on PATH")
    }

    fn test_layout(root: &Path, probe: &NodeProbe) -> RuntimeLayout {
        let runtime_root = root.join("dsh-runtime");
        RuntimeLayout {
            entry: runtime_root.join("lib/bin.cjs"),
            runtime_root,
            spawn_helper: None,
            manifest: RuntimeManifest {
                schema_version: 1,
                app: AppManifest {
                    version: "0.1.0".into(),
                    edition: "lite".into(),
                    target: "test-target".into(),
                },
                dsh: DshManifest {
                    commit: "test-commit".into(),
                    tag: None,
                    node_engine: "^22.19.0 || >=24.0.0".into(),
                    entry: "dsh-runtime/lib/bin.cjs".into(),
                },
                native: NativeManifest {
                    platform: probe.platform.clone(),
                    arch: probe.arch.clone(),
                    node_abi: probe.abi.clone(),
                    node_pty_package: "node_modules/node-pty".into(),
                    node_pty_spawn_helper: None,
                },
                bundled_node: None,
                plugins: Vec::new(),
            },
        }
    }

    fn write_fake_pty(layout: &RuntimeLayout, source: &str) {
        let package = layout
            .runtime_root
            .join(&layout.manifest.native.node_pty_package);
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"name":"node-pty","main":"index.js"}"#,
        )
        .unwrap();
        fs::write(package.join("index.js"), source).unwrap();
    }

    #[test]
    fn dsh_node_range_accepts_the_supported_lines() {
        let range = Range::parse("^22.19.0 || >=24.0.0").unwrap();
        assert!(range.satisfies(&Version::parse("22.19.1").unwrap()));
        assert!(range.satisfies(&Version::parse("24.0.0").unwrap()));
        assert!(!range.satisfies(&Version::parse("23.9.0").unwrap()));
    }

    #[test]
    fn configured_node_schema_rejects_unknown_fields() {
        let invalid = r#"{"schemaVersion":1,"nodePath":"/node","extra":true}"#;
        assert!(serde_json::from_str::<LiteNodeConfig>(invalid).is_err());
    }

    #[test]
    fn reports_node_not_found_when_discovery_has_no_candidates() {
        let error = resolve_candidate_paths(Vec::new()).unwrap_err();
        assert_eq!(error.code, NODE_NOT_FOUND);
    }

    #[test]
    fn rejects_a_stale_configured_node_path() {
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let config = LiteNodeConfig {
            schema_version: 1,
            node_path: dirs.root.join("missing-node"),
        };
        fs::write(config_path(&dirs), serde_json::to_vec(&config).unwrap()).unwrap();
        let error = resolve_node(&dirs).unwrap_err();
        assert_eq!(error.code, NODE_NOT_EXECUTABLE);
    }

    #[test]
    fn rejects_an_unsupported_node_version() {
        let root = tempfile::tempdir().unwrap();
        let probe = NodeProbe {
            version: "20.0.0".into(),
            abi: "115".into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
        };
        let layout = test_layout(root.path(), &probe);
        let error = validate_probe(Path::new("node"), &probe, &layout).unwrap_err();
        assert_eq!(error.code, NODE_VERSION_UNSUPPORTED);
    }

    #[test]
    fn rejects_a_node_from_the_wrong_architecture() {
        let root = tempfile::tempdir().unwrap();
        let probe = NodeProbe {
            version: "24.19.0".into(),
            abi: "137".into(),
            platform: "darwin".into(),
            arch: "x64".into(),
        };
        let mut layout = test_layout(root.path(), &probe);
        layout.manifest.native.arch = "arm64".into();
        let error = validate_probe(Path::new("node"), &probe, &layout).unwrap_err();
        assert_eq!(error.code, NODE_ARCH_MISMATCH);
    }

    #[test]
    fn maps_a_hung_node_probe_to_the_timeout_code() {
        let node = installed_node();
        let error = probe_node_with_script(
            &node,
            "setTimeout(() => {}, 1000)",
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert_eq!(error.code, NODE_PREFLIGHT_TIMEOUT);
    }

    #[test]
    fn rejects_a_missing_spawn_helper_before_loading_node_pty() {
        let node = installed_node();
        let probe = probe_node(&node).unwrap();
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let mut layout = test_layout(home.path(), &probe);
        write_fake_pty(&layout, "module.exports = {};");
        layout.spawn_helper = Some(home.path().join("missing-spawn-helper"));
        let error = smoke_test_native_module(&node, &probe, &dirs, &layout).unwrap_err();
        assert_eq!(error.code, NODE_NATIVE_MODULE_INCOMPATIBLE);
    }

    #[test]
    fn rejects_a_node_pty_load_failure() {
        let node = installed_node();
        let probe = probe_node(&node).unwrap();
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let layout = test_layout(home.path(), &probe);
        write_fake_pty(&layout, "throw new Error('simulated ABI mismatch');");
        let error = smoke_test_native_module(&node, &probe, &dirs, &layout).unwrap_err();
        assert_eq!(error.code, NODE_NATIVE_MODULE_INCOMPATIBLE);
    }

    #[test]
    fn rejects_a_failed_dsh_configuration_preflight() {
        let node = installed_node();
        let probe = probe_node(&node).unwrap();
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let layout = test_layout(home.path(), &probe);
        fs::create_dir_all(layout.entry.parent().unwrap()).unwrap();
        fs::write(&layout.entry, "process.exit(7);\n").unwrap();
        let patch = dirs.runtime.join("test.patch.json");
        fs::write(&patch, "[]\n").unwrap();
        let error = preflight_dsh(&node, &probe, &dirs, &layout, &patch).unwrap_err();
        assert_eq!(error.code, DSH_PREFLIGHT_FAILED);
    }

    #[test]
    fn accepts_a_compatible_node_through_native_and_dsh_preflights() {
        let node = installed_node();
        let probe = probe_node(&node).unwrap();
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let layout = test_layout(home.path(), &probe);
        write_fake_pty(
            &layout,
            r#"
module.exports = {
  spawn() {
    return {
      onExit(callback) { setImmediate(() => callback({ exitCode: 0 })); },
      kill() {},
    };
  },
};
"#,
        );
        fs::create_dir_all(layout.entry.parent().unwrap()).unwrap();
        fs::write(&layout.entry, "process.exit(0);\n").unwrap();
        let patch = dirs.runtime.join("test.patch.json");
        fs::write(&patch, "[]\n").unwrap();

        validate_probe(&node, &probe, &layout).unwrap();
        smoke_test_native_module(&node, &probe, &dirs, &layout).unwrap();
        preflight_dsh(&node, &probe, &dirs, &layout, &patch).unwrap();
    }
}

#[cfg(test)]
mod current_tests {
    use super::*;

    #[test]
    fn dsh_node_range_accepts_supported_release_lines() {
        let range = Range::parse("^22.19.0 || >=24.0.0").unwrap();
        assert!(range.satisfies(&Version::parse("22.19.1").unwrap()));
        assert!(range.satisfies(&Version::parse("24.0.0").unwrap()));
        assert!(!range.satisfies(&Version::parse("23.9.0").unwrap()));
    }

    #[test]
    fn configured_node_schema_rejects_unknown_fields() {
        let invalid = r#"{"schemaVersion":1,"nodePath":"/node","extra":true}"#;
        assert!(serde_json::from_str::<LiteNodeConfig>(invalid).is_err());
    }

    #[test]
    fn a_hung_node_probe_maps_to_the_timeout_code() {
        let node = env::split_paths(&env::var_os("PATH").expect("tests require PATH"))
            .map(|directory| directory.join(node_filename()))
            .find(|candidate| candidate.is_file())
            .expect("tests require Node on PATH");
        let error = probe_node_with_script(
            &node,
            "setTimeout(() => {}, 1000)",
            Duration::from_millis(20),
        )
        .unwrap_err();
        assert_eq!(error.code, NODE_PREFLIGHT_TIMEOUT);
    }

    #[cfg(not(windows))]
    #[test]
    fn extracts_a_contained_official_style_node_archive() {
        use std::io::Cursor;

        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("node.tar.gz");
        let output = File::create(&archive).unwrap();
        let encoder = flate2::write::GzEncoder::new(output, flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let bytes = b"node";
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "node-v24.19.0/bin/node", Cursor::new(bytes))
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let extracted = temporary.path().join("extracted");
        fs::create_dir(&extracted).unwrap();
        extract_node_archive(&archive, &extracted).unwrap();
        let root = single_extracted_directory(&extracted).unwrap();
        assert_eq!(fs::read(root.join("bin/node")).unwrap(), bytes);
    }
}
