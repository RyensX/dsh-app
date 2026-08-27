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
use tauri::{Manager, RunEvent, Runtime};

fn navigation_policy<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-policy")
        .on_navigation(|webview, url| {
            let app = webview.app_handle();
            let Some(state) = app.try_state::<AppState>() else {
                return url.scheme() == "tauri"
                    || url.host_str() == Some("tauri.localhost")
                    || url.host_str() == Some("127.0.0.1");
            };
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
            let window = app
                .get_webview_window("main")
                .ok_or("main WebView window is missing")?;
            #[cfg(target_os = "macos")]
            macos_window::install(&window)?;
            let url = window.url()?;
            app.state::<AppState>().set_bootstrap_url(url);
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
