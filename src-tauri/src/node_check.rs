use node_semver::{Range, Version};
use serde::Deserialize;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::LaunchError;
use crate::model::{BootstrapManifest, RuntimeLayout};
use crate::process::configure_background_process;
use crate::user_dirs::UserDirs;

const NODE_TIMEOUT: Duration = Duration::from_secs(5);
const DSH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Deserialize)]
pub struct NodeIdentity {
    pub version: String,
    pub abi: String,
    pub platform: String,
    pub arch: String,
}

struct CapturedOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

pub fn probe(node: &Path) -> Result<NodeIdentity, LaunchError> {
    const SCRIPT: &str = r#"process.stdout.write(JSON.stringify({version:process.version.slice(1),abi:String(process.versions.modules||''),platform:process.platform,arch:process.arch}))"#;
    let mut command = Command::new(node);
    command.args(["-e", SCRIPT]);
    clean_node_environment(&mut command);
    let output = capture_with_timeout(&mut command, NODE_TIMEOUT).map_err(|error| {
        LaunchError::io(
            "NODE_NOT_EXECUTABLE",
            "The selected Node executable could not be launched",
            "Choose another Node installation or retry the managed download.",
            &error,
        )
        .detail("Node path", node.display().to_string())
    })?;
    if output.timed_out {
        return Err(timeout_error(
            node,
            "Node did not report its identity within 5 seconds.",
        ));
    }
    if !output.status.success() {
        return Err(LaunchError::new(
            "NODE_NOT_EXECUTABLE",
            "The selected executable is not a working Node runtime",
            "DSH App could not obtain a valid Node identity.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Underlying error", bounded_reason(&output)));
    }
    serde_json::from_str(&output.stdout).map_err(|error| {
        LaunchError::new(
            "NODE_NOT_EXECUTABLE",
            "The executable returned an invalid Node identity",
            "Choose another Node installation or retry the managed download.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Underlying error", error.to_string())
    })
}

pub fn validate_bootstrap(
    node: &Path,
    identity: &NodeIdentity,
    bootstrap: &BootstrapManifest,
) -> Result<(), LaunchError> {
    validate_requirement(node, identity, &bootstrap.dsh.node_engine)?;
    validate_platform(
        node,
        identity,
        &bootstrap.node.platform,
        &bootstrap.node.arch,
    )
}

pub fn validate_runtime(
    node: &Path,
    identity: &NodeIdentity,
    layout: &RuntimeLayout,
) -> Result<(), LaunchError> {
    validate_requirement(node, identity, &layout.manifest.dsh.node_engine)?;
    validate_platform(
        node,
        identity,
        &layout.manifest.native.platform,
        &layout.manifest.native.arch,
    )?;
    if identity.abi != layout.manifest.native.node_abi {
        return Err(LaunchError::new(
            "NODE_NATIVE_MODULE_INCOMPATIBLE",
            "The dsh runtime was built for another Node ABI",
            "DSH App will ignore this runtime and use or build a compatible candidate.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Detected ABI", &identity.abi)
        .detail("Runtime ABI", &layout.manifest.native.node_abi));
    }
    Ok(())
}

pub fn preflight(
    node: &Path,
    identity: &NodeIdentity,
    dirs: &UserDirs,
    layout: &RuntimeLayout,
    patch: &Path,
) -> Result<(), LaunchError> {
    smoke_test_node_pty(node, identity, dirs, layout)?;
    preflight_dsh(node, identity, dirs, layout, patch)
}

fn validate_requirement(
    node: &Path,
    identity: &NodeIdentity,
    requirement: &str,
) -> Result<(), LaunchError> {
    let range = Range::parse(requirement).map_err(|error| {
        LaunchError::new(
            "DSH_PREFLIGHT_FAILED",
            "The dsh Node requirement is invalid",
            "The runtime manifest contains a Node range that cannot be evaluated.",
        )
        .detail("Required Node", requirement)
        .detail("Underlying error", error.to_string())
    })?;
    let version = Version::parse(&identity.version).map_err(|error| {
        LaunchError::new(
            "NODE_VERSION_UNSUPPORTED",
            "The detected Node version is invalid",
            "Choose another Node installation.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Underlying error", error.to_string())
    })?;
    if range.satisfies(&version) {
        return Ok(());
    }
    Err(LaunchError::new(
        "NODE_VERSION_UNSUPPORTED",
        "The detected Node version is not supported",
        "Use a Node version that satisfies the current dsh runtime.",
    )
    .detail("Node path", node.display().to_string())
    .detail("Detected version", format!("v{}", identity.version))
    .detail("Required version", requirement))
}

fn validate_platform(
    node: &Path,
    identity: &NodeIdentity,
    platform: &str,
    arch: &str,
) -> Result<(), LaunchError> {
    if identity.platform == platform && identity.arch == arch {
        return Ok(());
    }
    Err(LaunchError::new(
        "NODE_ARCH_MISMATCH",
        "The Node architecture does not match DSH App",
        "Use a Node executable for the same platform and CPU architecture.",
    )
    .detail("Node path", node.display().to_string())
    .detail(
        "Detected platform",
        format!("{}/{}", identity.platform, identity.arch),
    )
    .detail("Required platform", format!("{platform}/{arch}")))
}

fn smoke_test_node_pty(
    node: &Path,
    identity: &NodeIdentity,
    dirs: &UserDirs,
    layout: &RuntimeLayout,
) -> Result<(), LaunchError> {
    let package = layout
        .runtime_root
        .join(&layout.manifest.native.node_pty_package);
    if !package.join("package.json").is_file() {
        return Err(native_error(
            node,
            identity,
            layout,
            "node-pty package is missing",
        ));
    }
    if let Some(helper) = &layout.spawn_helper {
        if !helper.is_file() {
            return Err(native_error(
                node,
                identity,
                layout,
                &format!("spawn-helper is missing: {}", helper.display()),
            ));
        }
    }

    const SCRIPT: &str = r#"
const path = require('node:path');
const pty = require(path.resolve(process.argv[1]));
let settled = false;
const child = pty.spawn(process.execPath, ['-e', 'process.exit(0)'], {
  name: 'xterm-color', cols: 80, rows: 24, cwd: process.argv[2], env: process.env,
});
child.onExit(({ exitCode }) => { if (!settled) { settled = true; process.exit(exitCode); } });
setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch {} process.exit(124); } }, 3000);
"#;
    let mut command = Command::new(node);
    command
        .arg("-e")
        .arg(SCRIPT)
        .arg(&package)
        .arg(&dirs.workspace)
        .current_dir(&layout.runtime_root);
    clean_node_environment(&mut command);
    if let Some(helper) = &layout.spawn_helper {
        command.env("DSH_NODE_PTY_SPAWN_HELPER", helper);
    }
    let output = capture_with_timeout(&mut command, NODE_TIMEOUT)
        .map_err(|error| native_error(node, identity, layout, &error.to_string()))?;
    if output.timed_out {
        return Err(timeout_error(
            node,
            "The node-pty smoke test exceeded 5 seconds.",
        ));
    }
    if !output.status.success() {
        return Err(native_error(
            node,
            identity,
            layout,
            &bounded_reason(&output),
        ));
    }
    Ok(())
}

fn preflight_dsh(
    node: &Path,
    identity: &NodeIdentity,
    dirs: &UserDirs,
    layout: &RuntimeLayout,
    patch: &Path,
) -> Result<(), LaunchError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary_home = dirs
        .runtime
        .join(format!("preflight-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&temporary_home).map_err(|error| {
        LaunchError::io(
            "USER_DATA_DIR_NOT_WRITABLE",
            "The dsh preflight directory is not writable",
            "Check the DSH App personal directory permissions.",
            &error,
        )
    })?;
    let mut command = Command::new(node);
    command
        .arg(&layout.entry)
        .args(["--profile", "web", "--patch"])
        .arg(patch)
        .arg("--dump-config")
        .current_dir(&dirs.workspace)
        .env("DSH_HOME", &temporary_home)
        .env("DSH_TELEMETRY_DISABLED", "1");
    clean_node_environment(&mut command);
    if let Some(helper) = &layout.spawn_helper {
        command.env("DSH_NODE_PTY_SPAWN_HELPER", helper);
    }
    let result = capture_with_timeout(&mut command, DSH_TIMEOUT);
    let _ = fs::remove_dir_all(&temporary_home);
    let output = result.map_err(|error| {
        LaunchError::new(
            "DSH_PREFLIGHT_FAILED",
            "The dsh configuration preflight could not start",
            "The selected runtime is not usable with this Node installation.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Detected version", format!("v{}", identity.version))
        .detail("Underlying error", error.to_string())
    })?;
    if output.timed_out {
        return Err(timeout_error(
            node,
            "The dsh preflight exceeded 15 seconds.",
        ));
    }
    if !output.status.success() {
        return Err(LaunchError::new(
            "DSH_PREFLIGHT_FAILED",
            "The dsh configuration preflight failed",
            "The runtime, Web bundle, or generated plugin patch could not be resolved.",
        )
        .detail("Node path", node.display().to_string())
        .detail("Detected ABI", &identity.abi)
        .detail("Underlying error", bounded_reason(&output)));
    }
    Ok(())
}

fn capture_with_timeout(command: &mut Command, timeout: Duration) -> io::Result<CapturedOutput> {
    configure_background_process(command);
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
    Ok(CapturedOutput {
        status,
        stdout: String::from_utf8_lossy(&stdout_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?)
            .into_owned(),
        stderr: String::from_utf8_lossy(&stderr_reader.join().unwrap_or_else(|_| Ok(Vec::new()))?)
            .into_owned(),
        timed_out,
    })
}

fn read_all(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn clean_node_environment(command: &mut Command) {
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
    let chars = safe.chars().collect::<Vec<_>>();
    if chars.len() > 4000 {
        chars[chars.len() - 4000..].iter().collect()
    } else if safe.is_empty() {
        format!("process exited with {}", output.status)
    } else {
        safe
    }
}

fn timeout_error(node: &Path, reason: &str) -> LaunchError {
    LaunchError::new(
        "NODE_PREFLIGHT_TIMEOUT",
        "The Node or dsh preflight timed out",
        "A required runtime check did not complete in time.",
    )
    .detail("Node path", node.display().to_string())
    .detail("Underlying error", reason)
}

fn native_error(
    node: &Path,
    identity: &NodeIdentity,
    layout: &RuntimeLayout,
    reason: &str,
) -> LaunchError {
    LaunchError::new(
        "NODE_NATIVE_MODULE_INCOMPATIBLE",
        "Node cannot load the dsh native modules",
        "Use or build a runtime compatible with this Node installation.",
    )
    .detail("Node path", node.display().to_string())
    .detail("Detected version", format!("v{}", identity.version))
    .detail("Detected ABI", &identity.abi)
    .detail("Runtime ABI", &layout.manifest.native.node_abi)
    .detail("Underlying error", reason)
}
