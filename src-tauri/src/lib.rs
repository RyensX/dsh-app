#[cfg(all(feature = "bundled", feature = "lite"))]
compile_error!("features bundled and lite are mutually exclusive");

#[cfg(not(any(feature = "bundled", feature = "lite")))]
compile_error!("exactly one of bundled or lite must be enabled");

mod app;
mod atomic;
#[cfg(feature = "bundled")]
mod bundled_node;
mod error;
#[cfg(feature = "lite")]
mod lite_node;
mod logging;
#[cfg(target_os = "macos")]
mod macos_window;
mod model;
mod node_check;
mod plugin_patch;
mod process;
mod readiness;
mod runtime;
mod runtime_manager;
mod user_dirs;

use app::AppState;
use readiness::same_origin;
use tauri::{AppHandle, Manager, RunEvent, Runtime, Url};

fn is_packaged_bootstrap_url(url: &Url) -> bool {
    let native_protocol = url.scheme() == "tauri" && url.host_str() == Some("localhost");
    let webview_protocol =
        matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost");
    (native_protocol || webview_protocol)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_bootstrap_url<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    if tauri::is_dev() {
        return app
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev_url| same_origin(dev_url, url));
    }
    is_packaged_bootstrap_url(url)
}

fn navigation_policy<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-policy")
        .on_navigation(|webview, url| {
            let app = webview.app_handle();
            let Some(state) = app.try_state::<AppState>() else {
                return url.scheme() == "tauri"
                    || url.host_str() == Some("tauri.localhost")
                    || url.host_str() == Some("127.0.0.1");
            };
            if is_bootstrap_url(app, url) {
                // 记录 WebView 实际采用的本地入口，避免依赖平台相关的 URL 映射与时序。
                state.set_bootstrap_url(url.clone());
                return true;
            }
            if state.navigation_allowed(url) {
                return true;
            }
            if url.scheme() == "https" {
                let _ = open::that_detached(url.as_str());
            }
            false
        })
        .build()
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                // 首次加载期间保持隐藏，由 page-load 回调统一负责第一次显示。
                if !window.is_visible().unwrap_or(true) {
                    return;
                }
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(navigation_policy())
        .setup(|app| {
            user_dirs::UserDirs::resolve(app.handle()).map_err(|error| {
                std::io::Error::other(format!("{}: {}", error.title, error.message))
            })?;
            app.manage(AppState::new());
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .cloned()
                .ok_or("main WebView window configuration is missing")?;
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .on_page_load(|window, payload| {
                    if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                        || !is_bootstrap_url(window.app_handle(), payload.url())
                    {
                        return;
                    }
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        state.set_bootstrap_url(payload.url().clone());
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                })
                .build()?;
            #[cfg(target_os = "macos")]
            macos_window::install(&window)?;
            Ok(())
        });

    #[cfg(target_os = "macos")]
    let builder = builder.on_page_load(|webview, payload| {
        if webview.label() != "main"
            || payload.url().host_str() != Some("127.0.0.1")
            || !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
        {
            return;
        }
        if let Some(window) = webview.app_handle().get_webview_window("main") {
            macos_window::publish(&window);
        }
    });

    #[cfg(all(feature = "lite", not(feature = "bundled")))]
    let builder =
        builder
            .plugin(tauri_plugin_dialog::init())
            .invoke_handler(tauri::generate_handler![
                app::get_bootstrap_info,
                app::get_launch_status,
                app::start_dsh,
                app::stop_dsh,
                app::open_data_directory,
                app::set_lite_node_path
            ]);

    #[cfg(all(feature = "bundled", not(feature = "lite")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app::get_bootstrap_info,
        app::get_launch_status,
        app::start_dsh,
        app::stop_dsh,
        app::open_data_directory
    ]);

    let application = builder
        .build(tauri::generate_context!())
        .expect("failed to build DSH App");
    application.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            app::save_window_state_if_ready(app);
            #[cfg(target_os = "macos")]
            macos_window::uninstall();
            app::shutdown(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_packaged_webview_origins() {
        for value in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/lite.html",
        ] {
            assert!(is_packaged_bootstrap_url(&Url::parse(value).unwrap()));
        }
        for value in [
            "about:blank",
            "https://example.com/",
            "http://tauri.localhost.evil/",
            "http://tauri.localhost:1420/",
        ] {
            assert!(!is_packaged_bootstrap_url(&Url::parse(value).unwrap()));
        }
    }
}
