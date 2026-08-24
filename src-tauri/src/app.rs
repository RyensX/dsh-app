use command_group::GroupChild;
use serde::Deserialize;
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, RwLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, Url, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

use crate::atomic::atomic_write;
use crate::error::LaunchError;
use crate::logging::{open_rotating, write_line, SharedLog};
use crate::model::{BootstrapInfo, BootstrapManifest, LaunchStatus};
use crate::node_check;
use crate::plugin_patch::rebuild_patch;
use crate::process::{graceful_stop, spawn_group};
use crate::readiness::{parse_readiness_line, same_origin};
use crate::runtime::resolve_bootstrap;
use crate::runtime_manager;
use crate::user_dirs::UserDirs;

const START_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(6);
const WINDOW_STATE_SAVE_DEBOUNCE: Duration = Duration::from_millis(250);

pub struct AppState {
    inner: Mutex<InnerState>,
    bootstrap_url: RwLock<Option<Url>>,
    dsh_url: RwLock<Option<Url>>,
}

struct InnerState {
    generation: u64,
    launching: bool,
    stopping: bool,
    window_state_registered: bool,
    status: LaunchStatus,
    child: Option<GroupChild>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(InnerState {
                generation: 0,
                launching: false,
                stopping: false,
                window_state_registered: false,
                status: LaunchStatus::default(),
                child: None,
            }),
            bootstrap_url: RwLock::new(None),
            dsh_url: RwLock::new(None),
        }
    }

    pub fn set_bootstrap_url(&self, url: Url) {
        *self
            .bootstrap_url
            .write()
            .expect("bootstrap URL lock poisoned") = Some(url);
    }

    pub fn navigation_allowed(&self, url: &Url) -> bool {
        if self
            .bootstrap_url
            .read()
            .expect("bootstrap URL lock poisoned")
            .as_ref()
            .is_some_and(|bootstrap| same_origin(bootstrap, url))
        {
            return true;
        }
        self.dsh_url
            .read()
            .expect("dsh URL lock poisoned")
            .as_ref()
            .is_some_and(|dsh| same_origin(dsh, url))
    }

    fn window_state_registered(&self) -> bool {
        self.inner
            .lock()
            .expect("application state lock poisoned")
            .window_state_registered
    }
}

#[tauri::command]
pub fn get_launch_status(state: State<'_, AppState>) -> LaunchStatus {
    state
        .inner
        .lock()
        .expect("application state lock poisoned")
        .status
        .clone()
}

#[tauri::command]
pub fn get_bootstrap_info(app: AppHandle) -> Result<BootstrapInfo, LaunchError> {
    let dirs = UserDirs::resolve(&app)?;
    let bootstrap = resolve_bootstrap(&app)?;
    validate_bootstrap_identity(&bootstrap)?;
    Ok(BootstrapInfo {
        edition: edition(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        dsh_version: bootstrap.dsh.version,
        dsh_commit: bootstrap.dsh.commit,
        user_root: dirs.root.display().to_string(),
        required_node: bootstrap.dsh.node_engine,
    })
}

#[tauri::command]
pub fn start_dsh(app: AppHandle, state: State<'_, AppState>) -> LaunchStatus {
    let status = {
        let mut inner = state.inner.lock().expect("application state lock poisoned");
        if inner.launching || inner.child.is_some() {
            return inner.status.clone();
        }
        inner.generation = inner.generation.wrapping_add(1);
        inner.launching = true;
        inner.stopping = false;
        inner.status = LaunchStatus::Starting {
            message: starting_message().into(),
        };
        inner.status.clone()
    };
    emit_status(&app, &status);
    let generation = state
        .inner
        .lock()
        .expect("application state lock poisoned")
        .generation;
    thread::spawn(move || launch_worker(app, generation));
    status
}

#[tauri::command]
pub fn stop_dsh(app: AppHandle) {
    shutdown(&app);
}

#[tauri::command]
pub fn open_data_directory(app: AppHandle) -> Result<(), LaunchError> {
    let dirs = UserDirs::resolve(&app)?;
    open::that_detached(&dirs.root).map_err(|error| {
        LaunchError::new(
            "DATA_DIRECTORY_OPEN_FAILED",
            "The data directory could not be opened",
            "Open the DSH App data directory manually or check the desktop file-manager association.",
        )
        .detail("Path", dirs.root.display().to_string())
        .detail("Underlying error", error.to_string())
    })
}

#[cfg(feature = "lite")]
#[tauri::command]
pub fn set_lite_node_path(app: AppHandle, path: String) -> Result<(), LaunchError> {
    let dirs = UserDirs::resolve(&app)?;
    crate::lite_node::set_configured_path(&app, &dirs, &path)
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut inner = state.inner.lock().expect("application state lock poisoned");
    inner.stopping = true;
    inner.launching = false;
    if let Some(mut child) = inner.child.take() {
        graceful_stop(&mut child, STOP_GRACE);
    }
}

fn launch_worker(app: AppHandle, generation: u64) {
    let error =
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| launch(&app, generation))) {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error,
            Err(payload) => LaunchError::new(
                "DSH_LAUNCH_PANIC",
                "The dsh launch worker stopped unexpectedly",
                "DSH App caught an internal panic and reset the launch state.",
            )
            .detail("Panic", panic_message(payload.as_ref())),
        };
    if let Ok(dirs) = UserDirs::resolve(&app) {
        runtime_manager::rollback_failed_pending(&dirs);
    }
    terminate_generation(&app, generation);
    finish_failure(&app, generation, error);
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".into())
}

fn launch(app: &AppHandle, generation: u64) -> Result<(), LaunchError> {
    let dirs = UserDirs::resolve(app)?;
    let bootstrap = resolve_bootstrap(app)?;
    validate_bootstrap_identity(&bootstrap)?;

    #[cfg(all(feature = "bundled", not(feature = "lite")))]
    let node = crate::bundled_node::resolve(app, &bootstrap)?;
    #[cfg(all(feature = "lite", not(feature = "bundled")))]
    let node = crate::lite_node::resolve_for_bootstrap(&dirs, &bootstrap)?;
    #[cfg(any(
        all(feature = "bundled", feature = "lite"),
        not(any(feature = "bundled", feature = "lite"))
    ))]
    let node = std::path::PathBuf::new();

    let identity = node_check::probe(&node)?;
    node_check::validate_bootstrap(&node, &identity, &bootstrap)?;
    let selected = runtime_manager::resolve(app, &dirs, &bootstrap, &node, &identity)?;
    let layout = &selected.layout;
    let remote_plugins =
        runtime_manager::reconcile_remote_plugins(app, &dirs, &bootstrap, &node, layout)?;
    let patch = rebuild_patch(layout, &dirs)?;
    node_check::preflight(&node, &identity, &dirs, layout, &patch)?;

    let log = open_rotating(&dirs.logs.join("dsh.log")).map_err(|error| {
        LaunchError::io(
            "USER_DATA_DIR_NOT_WRITABLE",
            "The dsh log file is not writable",
            "Check the DSH App personal directory permissions.",
            &error,
        )
    })?;
    for warning in remote_plugins.warnings {
        write_line(&log, "remote-plugin", &warning);
    }
    write_line(&log, "app", "starting managed dsh process");

    let mut command = Command::new(&node);
    command
        .arg(&layout.entry)
        .args(["--profile", "web", "--patch"])
        .arg(&patch)
        .args(["--port", "0"])
        .arg("--no-open")
        .current_dir(&dirs.workspace)
        .env("DSH_HOME", &dirs.profile)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(helper) = &layout.spawn_helper {
        command.env("DSH_NODE_PTY_SPAWN_HELPER", helper);
    }
    configure_runtime_plugin_environment(
        app,
        &dirs,
        &bootstrap,
        &selected,
        &node,
        generation,
        &mut command,
    )?;

    let mut child = spawn_group(&mut command).map_err(|error| {
        LaunchError::io(
            "DSH_START_FAILED",
            "DeepSeek Harness could not be started",
            "The managed dsh child process failed to launch.",
            &error,
        )
        .detail("Node path", node.display().to_string())
        .detail("Runtime entry", layout.entry.display().to_string())
    })?;
    let stdout = child
        .inner()
        .stdout
        .take()
        .expect("dsh stdout was configured as piped");
    let stderr = child
        .inner()
        .stderr
        .take()
        .expect("dsh stderr was configured as piped");

    {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().expect("application state lock poisoned");
        if inner.generation != generation || inner.stopping {
            graceful_stop(&mut child, STOP_GRACE);
            return Ok(());
        }
        inner.child = Some(child);
    }

    let (ready_sender, ready_receiver) = mpsc::channel();
    let stdout_log = log.clone();
    let window_state_log = log.clone();
    thread::spawn(move || read_output(stdout, "stdout", stdout_log, Some(ready_sender)));
    thread::spawn(move || read_output(stderr, "stderr", log, None));
    spawn_exit_watcher(
        app.clone(),
        generation,
        control_request_path(&dirs, generation),
    );

    let result = ready_receiver.recv_timeout(START_TIMEOUT);
    if already_failed(app, generation) {
        return Ok(());
    }
    let url = match result {
        Ok(Ok(url)) => url,
        Ok(Err(reason)) => {
            return Err(LaunchError::new(
                "DSH_READY_URL_INVALID",
                "DeepSeek Harness reported an unsafe URL",
                "DSH App accepts only an ephemeral IPv4 loopback HTTP origin.",
            )
            .detail("Underlying error", reason));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(LaunchError::new(
                "DSH_START_TIMEOUT",
                "DeepSeek Harness did not become ready",
                "No valid loopback readiness URL appeared within 30 seconds.",
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(LaunchError::new(
                "DSH_EXITED_BEFORE_READY",
                "DeepSeek Harness exited during startup",
                "Review the dsh log and retry after correcting the reported runtime error.",
            ));
        }
    };

    let status = LaunchStatus::Ready {
        url: url.to_string(),
    };
    runtime_manager::commit_pending(&dirs, &selected)?;
    {
        let state = app.state::<AppState>();
        let mut inner = state.inner.lock().expect("application state lock poisoned");
        if inner.generation != generation || inner.child.is_none() || inner.stopping {
            return Ok(());
        }
        inner.launching = false;
        inner.status = status.clone();
        *state.dsh_url.write().expect("dsh URL lock poisoned") = Some(url.clone());
    }
    emit_status(app, &status);
    let window = app.get_webview_window("main").ok_or_else(|| {
        LaunchError::new(
            "WEBVIEW_UNAVAILABLE",
            "The DSH App window is unavailable",
            "The local dsh server started, but its desktop window could not be found.",
        )
    })?;
    window.navigate(url).map_err(|error| {
        LaunchError::new(
            "WEBVIEW_NAVIGATION_FAILED",
            "The DeepSeek Harness page could not be opened",
            "The local dsh server is ready, but WebView navigation failed.",
        )
        .detail("Underlying error", error.to_string())
    })?;

    let should_register_window_state = {
        let state = app.state::<AppState>();
        let registered = state
            .inner
            .lock()
            .expect("application state lock poisoned")
            .window_state_registered;
        !registered
    };
    if should_register_window_state {
        // 启动页保持默认尺寸和居中位置；dsh 首次就绪后才开始恢复及持久化窗口状态。
        if let Err(error) = normalize_maximized_restore_position(&dirs.window_state) {
            write_line(
                &window_state_log,
                "app",
                &format!("window state normalization failed: {error}"),
            );
        }
        match app.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .with_filename(dirs.window_state.to_string_lossy().into_owned())
                .skip_initial_state("main")
                .build(),
        ) {
            Ok(()) => {
                if let Err(error) = window.restore_state(window_state_flags()) {
                    write_line(
                        &window_state_log,
                        "app",
                        &format!("window state restore failed: {error}"),
                    );
                }
                install_window_state_tracking(app, &window, &window_state_log);
                app.state::<AppState>()
                    .inner
                    .lock()
                    .expect("application state lock poisoned")
                    .window_state_registered = true;
            }
            Err(error) => {
                write_line(
                    &window_state_log,
                    "app",
                    &format!("window state registration failed: {error}"),
                );
            }
        }
    }
    Ok(())
}

fn install_window_state_tracking(app: &AppHandle, window: &tauri::WebviewWindow, log: &SharedLog) {
    let (save_sender, save_receiver) = mpsc::channel();
    let writer_app = app.clone();
    let writer_log = log.clone();
    thread::spawn(move || {
        run_debounced_window_state_saves(save_receiver, WINDOW_STATE_SAVE_DEBOUNCE, || {
            persist_window_state(&writer_app, Some(&writer_log))
        });
    });

    let close_app = app.clone();
    let close_log = log.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let _ = save_sender.send(());
        }
        WindowEvent::CloseRequested { .. } => {
            persist_window_state(&close_app, Some(&close_log));
        }
        _ => {}
    });
    write_line(log, "app", "window state tracking active");
}

fn run_debounced_window_state_saves<F>(
    receiver: mpsc::Receiver<()>,
    quiet_period: Duration,
    mut save: F,
) where
    F: FnMut(),
{
    while receiver.recv().is_ok() {
        let mut disconnected = false;
        loop {
            match receiver.recv_timeout(quiet_period) {
                Ok(()) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    disconnected = true;
                    break;
                }
            }
        }
        save();
        if disconnected {
            break;
        }
    }
}

fn persist_window_state(app: &AppHandle, log: Option<&SharedLog>) {
    if let Err(error) = app.save_window_state(window_state_flags()) {
        if let Some(log) = log {
            write_line(log, "app", &format!("window state save failed: {error}"));
        }
    }
}

fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

fn normalize_maximized_restore_position(path: &Path) -> Result<bool, String> {
    let source = match std::fs::read(path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    let mut root =
        serde_json::from_slice::<serde_json::Value>(&source).map_err(|error| error.to_string())?;
    let Some(main) = root
        .get_mut("main")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Ok(false);
    };
    if main.get("maximized").and_then(serde_json::Value::as_bool) != Some(true) {
        return Ok(false);
    }
    let x = main
        .get("x")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "main.x is missing or invalid".to_owned())?;
    let y = main
        .get("y")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "main.y is missing or invalid".to_owned())?;
    let already_normalized = main.get("prev_x").and_then(serde_json::Value::as_i64) == Some(x)
        && main.get("prev_y").and_then(serde_json::Value::as_i64) == Some(y);
    if already_normalized {
        return Ok(false);
    }

    // 延迟安装的追踪器会把 x/y 保留为最大化前的位置；插件恢复时从 prev_x/prev_y 读取它。
    main.insert("prev_x".into(), serde_json::Value::from(x));
    main.insert("prev_y".into(), serde_json::Value::from(y));
    let mut encoded = serde_json::to_vec_pretty(&root).map_err(|error| error.to_string())?;
    encoded.push(b'\n');
    atomic_write(path, &encoded).map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn save_window_state_if_ready(app: &AppHandle) {
    if app.state::<AppState>().window_state_registered() {
        persist_window_state(app, None);
    }
}

fn read_output<R: Read>(
    reader: R,
    stream: &'static str,
    log: SharedLog,
    ready: Option<Sender<Result<Url, String>>>,
) {
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    let mut readiness_sent = false;
    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&bytes);
                let line = line.trim_end_matches(['\r', '\n']);
                write_line(&log, stream, line);
                if !readiness_sent {
                    if let (Some(sender), Some(parsed)) = (&ready, parse_readiness_line(line)) {
                        let _ = sender.send(parsed);
                        readiness_sent = true;
                    }
                }
            }
            Err(error) => {
                write_line(&log, stream, &format!("output read failed: {error}"));
                break;
            }
        }
    }
}

fn spawn_exit_watcher(app: AppHandle, generation: u64, control_request: PathBuf) {
    thread::spawn(move || loop {
        // 控制请求由桌面进程接管，不再依赖 dsh 恰好先完成退出。
        if let Some(action) = consume_control_request(&control_request) {
            handle_control_action(&app, generation, action);
            return;
        }
        let outcome = {
            let state = app.state::<AppState>();
            let mut inner = state.inner.lock().expect("application state lock poisoned");
            if inner.generation != generation || inner.child.is_none() {
                return;
            }
            let outcome = inner
                .child
                .as_mut()
                .expect("child presence checked")
                .try_wait();
            match outcome {
                Ok(None) => None,
                Ok(Some(status)) => Some(Ok(status.to_string())),
                Err(error) => Some(Err(error.to_string())),
            }
        };
        if let Some(outcome) = outcome {
            if let Some(action) = consume_control_request(&control_request) {
                handle_control_action(&app, generation, action);
                return;
            }
            let state = app.state::<AppState>();
            let (status, should_navigate) = {
                let mut inner = state.inner.lock().expect("application state lock poisoned");
                if inner.generation != generation {
                    return;
                }
                let was_ready = matches!(inner.status, LaunchStatus::Ready { .. });
                inner.child.take();
                inner.launching = false;
                if inner.stopping {
                    return;
                }
                let error = match outcome {
                    Ok(exit) => LaunchError::new(
                        if was_ready {
                            "DSH_EXITED"
                        } else {
                            "DSH_EXITED_BEFORE_READY"
                        },
                        "DeepSeek Harness stopped unexpectedly",
                        "Review the dsh log, then retry when the underlying error is resolved.",
                    )
                    .detail("Exit status", exit),
                    Err(error) => LaunchError::new(
                        "DSH_PROCESS_MONITOR_FAILED",
                        "The dsh process could not be monitored",
                        "DSH App lost the managed child process state.",
                    )
                    .detail("Underlying error", error),
                };
                inner.status = LaunchStatus::Failed { error };
                (inner.status.clone(), was_ready)
            };
            emit_status(&app, &status);
            if should_navigate {
                navigate_to_bootstrap(&app);
            }
            return;
        }
        thread::sleep(Duration::from_millis(100));
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlRequest {
    schema_version: u32,
    action: String,
    not_before_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ControlAction {
    Restart,
    Quit,
}

fn consume_control_request(path: &Path) -> Option<ControlAction> {
    let now_ms = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    consume_control_request_at(path, now_ms)
}

fn consume_control_request_at(path: &Path, now_ms: u64) -> Option<ControlAction> {
    let source = match std::fs::read_to_string(path) {
        Ok(source) => source,
        Err(_) => return None,
    };
    let request = match serde_json::from_str::<ControlRequest>(&source) {
        Ok(request) => request,
        Err(_) => {
            let _ = std::fs::remove_file(path);
            return None;
        }
    };
    if request.schema_version != 1 {
        let _ = std::fs::remove_file(path);
        return None;
    }
    if request
        .not_before_ms
        .is_some_and(|not_before_ms| now_ms < not_before_ms)
    {
        return None;
    }
    let action = match request.action.as_str() {
        "restart" => ControlAction::Restart,
        "quit" => ControlAction::Quit,
        _ => {
            let _ = std::fs::remove_file(path);
            return None;
        }
    };
    let _ = std::fs::remove_file(path);
    Some(action)
}

fn handle_control_action(app: &AppHandle, generation: u64, action: ControlAction) {
    match action {
        ControlAction::Restart => restart_application(app, generation),
        ControlAction::Quit => quit_application(app, generation),
    }
}

fn restart_application(app: &AppHandle, generation: u64) {
    let state = app.state::<AppState>();
    let child = {
        let mut inner = state.inner.lock().expect("application state lock poisoned");
        if inner.generation != generation || inner.stopping {
            return;
        }
        inner.launching = false;
        inner.stopping = true;
        inner.child.take()
    };
    save_window_state_if_ready(app);
    if let Some(mut child) = child {
        graceful_stop(&mut child, STOP_GRACE);
    }
    // macOS 先释放单实例 socket，确保 Tauri 拉起的替代进程不会被旧实例拦截。
    #[cfg(target_os = "macos")]
    tauri_plugin_single_instance::destroy(app);
    // 重启完整桌面进程，重新创建本地启动页和 WebView。
    app.request_restart();
}

fn quit_application(app: &AppHandle, generation: u64) {
    let state = app.state::<AppState>();
    let child = {
        let mut inner = state.inner.lock().expect("application state lock poisoned");
        if inner.generation != generation || inner.stopping {
            return;
        }
        inner.launching = false;
        inner.stopping = true;
        inner.child.take()
    };
    save_window_state_if_ready(app);
    if let Some(mut child) = child {
        graceful_stop(&mut child, STOP_GRACE);
    }
    app.exit(0);
}

fn terminate_generation(app: &AppHandle, generation: u64) {
    let state = app.state::<AppState>();
    let mut inner = state.inner.lock().expect("application state lock poisoned");
    if inner.generation != generation {
        return;
    }
    inner.stopping = true;
    if let Some(mut child) = inner.child.take() {
        graceful_stop(&mut child, STOP_GRACE);
    }
    inner.stopping = false;
}

fn finish_failure(app: &AppHandle, generation: u64, error: LaunchError) {
    let state = app.state::<AppState>();
    let status = {
        let mut inner = state.inner.lock().expect("application state lock poisoned");
        if inner.generation != generation || matches!(inner.status, LaunchStatus::Failed { .. }) {
            return;
        }
        inner.launching = false;
        inner.status = LaunchStatus::Failed { error };
        inner.status.clone()
    };
    emit_status(app, &status);
    navigate_to_bootstrap(app);
}

fn already_failed(app: &AppHandle, generation: u64) -> bool {
    let state = app.state::<AppState>();
    let inner = state.inner.lock().expect("application state lock poisoned");
    inner.generation != generation || matches!(inner.status, LaunchStatus::Failed { .. })
}

fn navigate_to_bootstrap(app: &AppHandle) {
    let state = app.state::<AppState>();
    let url = state
        .bootstrap_url
        .read()
        .expect("bootstrap URL lock poisoned")
        .clone();
    *state.dsh_url.write().expect("dsh URL lock poisoned") = None;
    if let (Some(window), Some(url)) = (app.get_webview_window("main"), url) {
        let _ = window.navigate(url);
    }
}

fn emit_status(app: &AppHandle, status: &LaunchStatus) {
    let _ = app.emit("dsh-status", status);
}

fn configure_runtime_plugin_environment(
    app: &AppHandle,
    dirs: &UserDirs,
    bootstrap: &BootstrapManifest,
    selected: &runtime_manager::SelectedRuntime,
    node: &std::path::Path,
    generation: u64,
    command: &mut Command,
) -> Result<(), LaunchError> {
    let tools = runtime_manager::runtime_manager_paths(app)?;
    let request = control_request_path(dirs, generation);
    let _ = std::fs::remove_file(&request);
    let origin = match selected.origin {
        runtime_manager::RuntimeOrigin::Managed => "managed",
        runtime_manager::RuntimeOrigin::Bundled => "bundled",
    };
    let commit_time = selected
        .layout
        .manifest
        .dsh
        .commit_time
        .as_deref()
        .or_else(|| {
            (selected.layout.manifest.dsh.commit == bootstrap.dsh.commit)
                .then(|| bootstrap.dsh.commit_time.as_deref())
                .flatten()
        })
        .unwrap_or("");
    command
        .env("DSH_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env("DSH_APP_TARGET", env!("DSH_APP_TARGET_TRIPLE"))
        .env("DSH_APP_EDITION", edition())
        .env("DSH_APP_RUNTIME_ORIGIN", origin)
        .env("DSH_APP_DSH_REPOSITORY", &bootstrap.dsh.repository)
        .env("DSH_APP_DSH_COMMIT", &selected.layout.manifest.dsh.commit)
        .env("DSH_APP_DSH_COMMIT_TIME", commit_time)
        .env(
            "DSH_APP_DSH_TAG",
            selected.layout.manifest.dsh.tag.as_deref().unwrap_or(""),
        )
        .env("DSH_APP_BASELINE_COMMIT", &bootstrap.dsh.commit)
        .env(
            "DSH_APP_BASELINE_TAG",
            bootstrap.dsh.tag.as_deref().unwrap_or(""),
        )
        .env("DSH_APP_NODE", node)
        .env("DSH_APP_USER_RUNTIME", &dirs.runtime)
        .env("DSH_APP_CONFIG", &dirs.config)
        .env("DSH_APP_BOOTSTRAP_MANIFEST", tools.bootstrap)
        .env("DSH_APP_PLUGIN_PAYLOAD", tools.plugin_payload)
        .env("DSH_APP_REMOTE_PLUGINS", tools.remote_plugins)
        .env("DSH_APP_RUNTIME_MANAGER", tools.manager)
        .env("DSH_APP_COREPACK", tools.corepack)
        .env("DSH_APP_CONTROL_REQUEST", request)
        .env(
            "DSH_APP_HAS_BUILTIN",
            if cfg!(feature = "bundled") { "1" } else { "0" },
        );
    configure_profile_package_manager_environment(dirs, node, command)?;
    Ok(())
}

/// Keep profile mutations inside the same pinned pnpm/store environment used
/// by the runtime manager. Without this, plugins such as dshmarket can find a
/// system pnpm on PATH and pnpm rejects the App-managed node_modules as coming
/// from an unexpected store.
fn configure_profile_package_manager_environment(
    dirs: &UserDirs,
    node: &Path,
    command: &mut Command,
) -> Result<(), LaunchError> {
    let pnpm_home = dirs.runtime.join("dsh/cache/pnpm-home");
    let mut path_entries = vec![pnpm_home.clone()];
    if let Some(node_bin) = node.parent() {
        path_entries.push(node_bin.to_path_buf());
    }
    if let Some(path) = env::var_os("PATH") {
        path_entries.extend(env::split_paths(&path));
    }
    let path = env::join_paths(path_entries).map_err(|error| {
        LaunchError::new(
            "DSH_START_FAILED",
            "DeepSeek Harness could not be started",
            "The managed package-manager environment could not be prepared.",
        )
        .detail("Underlying error", error.to_string())
    })?;

    command
        .env("COREPACK_HOME", dirs.runtime.join("dsh/cache/corepack"))
        .env("PNPM_HOME", &pnpm_home)
        .env("npm_config_cache", dirs.runtime.join("dsh/cache/npm"))
        .env(
            "pnpm_config_store_dir",
            dirs.runtime.join("dsh/cache/pnpm-store"),
        )
        .env("pnpm_config_network_concurrency", "16")
        .env("pnpm_config_fetch_timeout", "300000")
        .env("pnpm_config_fetch_retries", "4")
        .env("PATH", path);
    Ok(())
}

fn control_request_path(dirs: &UserDirs, generation: u64) -> PathBuf {
    dirs.control.join(format!("launch-{generation}.json"))
}

fn validate_bootstrap_identity(bootstrap: &BootstrapManifest) -> Result<(), LaunchError> {
    if bootstrap.app.edition != edition()
        || bootstrap.app.target != env!("DSH_APP_TARGET_TRIPLE")
        || bootstrap.app.version != env!("CARGO_PKG_VERSION")
    {
        return Err(LaunchError::new(
            "RUNTIME_IDENTITY_MISMATCH",
            "The application bootstrap manifest does not match this executable",
            "Rebuild or reinstall DSH App so the edition and target are consistent.",
        )
        .detail("Executable edition", edition())
        .detail("Manifest edition", &bootstrap.app.edition)
        .detail("Executable target", env!("DSH_APP_TARGET_TRIPLE"))
        .detail("Manifest target", &bootstrap.app.target)
        .detail("Executable version", env!("CARGO_PKG_VERSION"))
        .detail("Manifest version", &bootstrap.app.version));
    }
    let repository = Url::parse(&bootstrap.dsh.repository).ok();
    let repository_is_safe = repository.as_ref().is_some_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url
                .path_segments()
                .is_some_and(|segments| segments.count() == 2)
    });
    if !repository_is_safe
        || bootstrap.dsh.package_manager != "pnpm@11.7.0"
        || bootstrap.dsh.commit.len() != 40
        || bootstrap.node.base_url != "https://nodejs.org/dist"
    {
        return Err(LaunchError::new(
            "RUNTIME_IDENTITY_MISMATCH",
            "The dsh source contract is invalid",
            "Rebuild DSH App from the reviewed submodule commit.",
        ));
    }
    let expected_platform = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "win32"
    };
    let expected_arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    if bootstrap.node.platform != expected_platform
        || bootstrap.node.arch != expected_arch
        || bootstrap.node.sha256.len() != 64
        || bootstrap.plugin_digest.len() != 64
    {
        return Err(LaunchError::new(
            "RUNTIME_IDENTITY_MISMATCH",
            "The bootstrap target does not match this executable",
            "Rebuild DSH App on its native target runner.",
        )
        .detail(
            "Manifest platform",
            format!("{}/{}", bootstrap.node.platform, bootstrap.node.arch),
        )
        .detail(
            "Expected platform",
            format!("{expected_platform}/{expected_arch}"),
        ));
    }
    Ok(())
}

#[cfg(all(feature = "bundled", not(feature = "lite")))]
fn edition() -> &'static str {
    "bundled"
}

#[cfg(all(feature = "lite", not(feature = "bundled")))]
fn edition() -> &'static str {
    "lite"
}

#[cfg(any(
    all(feature = "bundled", feature = "lite"),
    not(any(feature = "bundled", feature = "lite"))
))]
fn edition() -> &'static str {
    unreachable!("Cargo feature validation failed")
}

#[cfg(all(feature = "bundled", not(feature = "lite")))]
fn starting_message() -> &'static str {
    "Preparing the packaged runtime..."
}

#[cfg(all(feature = "lite", not(feature = "bundled")))]
fn starting_message() -> &'static str {
    "Checking the Lite runtime requirements..."
}

#[cfg(any(
    all(feature = "bundled", feature = "lite"),
    not(any(feature = "bundled", feature = "lite"))
))]
fn starting_message() -> &'static str {
    unreachable!("Cargo feature validation failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn command_env<'a>(command: &'a Command, key: &str) -> Option<&'a OsStr> {
        command.get_envs().find_map(
            |(name, value)| {
                if name == OsStr::new(key) {
                    value
                } else {
                    None
                }
            },
        )
    }

    #[test]
    fn launches_dsh_with_the_managed_profile_package_manager() {
        let home = tempfile::tempdir().unwrap();
        let dirs = UserDirs::from_home(home.path()).unwrap();
        let node = home.path().join("node/bin/node");
        let node_bin = node.parent().unwrap();
        let pnpm_home = dirs.runtime.join("dsh/cache/pnpm-home");
        let mut command = Command::new(&node);

        configure_profile_package_manager_environment(&dirs, &node, &mut command).unwrap();

        assert_eq!(
            command_env(&command, "COREPACK_HOME"),
            Some(dirs.runtime.join("dsh/cache/corepack").as_os_str())
        );
        assert_eq!(
            command_env(&command, "PNPM_HOME"),
            Some(pnpm_home.as_os_str())
        );
        assert_eq!(
            command_env(&command, "pnpm_config_store_dir"),
            Some(dirs.runtime.join("dsh/cache/pnpm-store").as_os_str())
        );
        assert_eq!(
            command_env(&command, "npm_config_cache"),
            Some(dirs.runtime.join("dsh/cache/npm").as_os_str())
        );
        assert_eq!(
            command_env(&command, "pnpm_config_network_concurrency"),
            Some(OsStr::new("16"))
        );
        assert_eq!(
            command_env(&command, "pnpm_config_fetch_timeout"),
            Some(OsStr::new("300000"))
        );
        assert_eq!(
            command_env(&command, "pnpm_config_fetch_retries"),
            Some(OsStr::new("4"))
        );

        let path_entries: Vec<_> =
            env::split_paths(command_env(&command, "PATH").unwrap()).collect();
        assert_eq!(path_entries.first(), Some(&pnpm_home));
        assert_eq!(path_entries.get(1), Some(&node_bin.to_path_buf()));
    }

    #[test]
    fn coalesces_a_window_event_burst_into_one_save() {
        let (sender, receiver) = mpsc::channel();
        sender.send(()).unwrap();
        sender.send(()).unwrap();
        sender.send(()).unwrap();
        drop(sender);

        let mut saves = 0;
        run_debounced_window_state_saves(receiver, Duration::from_millis(1), || saves += 1);
        assert_eq!(saves, 1);
    }

    #[test]
    fn window_state_contract_includes_maximized_state() {
        assert!(window_state_flags().contains(StateFlags::SIZE));
        assert!(window_state_flags().contains(StateFlags::POSITION));
        assert!(window_state_flags().contains(StateFlags::MAXIMIZED));
    }

    #[test]
    fn normalizes_the_pre_maximize_position_for_plugin_restore() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("window-state.json");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "main": {
                    "width": 1600,
                    "height": 1000,
                    "x": 620,
                    "y": 180,
                    "prev_x": 0,
                    "prev_y": 0,
                    "maximized": true,
                    "visible": true,
                    "decorated": true,
                    "fullscreen": false
                }
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(normalize_maximized_restore_position(&path).unwrap());
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(state["main"]["prev_x"], 620);
        assert_eq!(state["main"]["prev_y"], 180);
        assert!(!normalize_maximized_restore_position(&path).unwrap());
    }

    #[test]
    fn waits_for_the_control_ack_deadline_and_supports_quit() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("launch-1.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "action": "restart",
                "notBeforeMs": 5000
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(consume_control_request_at(&path, 4999), None);
        assert!(path.exists());
        assert_eq!(
            consume_control_request_at(&path, 5000),
            Some(ControlAction::Restart)
        );
        assert!(!path.exists());

        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "action": "quit"
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            consume_control_request_at(&path, 5000),
            Some(ControlAction::Quit)
        );
        assert!(!path.exists());
    }
}
