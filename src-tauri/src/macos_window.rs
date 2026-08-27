use std::cell::RefCell;
use std::io;
use std::ptr::{null_mut, NonNull};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSWindow, NSWindowButton, NSWindowStyleMask};
use serde::Serialize;
use tauri::{Runtime, WebviewWindow, WindowEvent};

const TRAFFIC_LIGHT_TRAILING_SAFE_MARGIN: f64 = 11.0;
const NATIVE_GEOMETRY_EVENT: &str = "dsh-app:macos-window-chrome";
const NATIVE_GEOMETRY_GLOBAL: &str = "__DSH_APP_MACOS_WINDOW_CHROME__";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MacosWindowChromeGeometry {
    traffic_light_safe_width: f64,
    titlebar_height: f64,
}

thread_local! {
    static EVENT_MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

pub fn install<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), Box<dyn std::error::Error>> {
    if EVENT_MONITOR.with(|monitor| monitor.borrow().is_some()) {
        return Ok(());
    }

    MainThreadMarker::new().ok_or_else(|| {
        io::Error::other("macOS window monitor must be installed on the main thread")
    })?;
    let ns_window = unsafe {
        window
            .ns_window()?
            .cast::<NSWindow>()
            .as_ref()
            .ok_or_else(|| io::Error::other("main NSWindow is unavailable"))?
    };
    let window_number = ns_window.windowNumber();

    // 原生点击判定与 WebView 使用同一份实时按钮几何，避免两侧安全边界漂移。
    let handler: RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> =
        RcBlock::new(move |event_pointer: NonNull<NSEvent>| {
            let event = unsafe { event_pointer.as_ref() };
            if event.windowNumber() != window_number {
                return event_pointer.as_ptr();
            }

            let marker = unsafe { MainThreadMarker::new_unchecked() };
            let Some(event_window) = event.window(marker) else {
                return event_pointer.as_ptr();
            };
            let point = event.locationInWindow();
            let geometry = measure_window_chrome(&event_window);
            if !is_titlebar_point(point.x, point.y, event_window.frame().size.height, geometry) {
                return event_pointer.as_ptr();
            }

            match event.clickCount() {
                1 => event_window.performWindowDragWithEvent(event),
                2 => event_window.performZoom(None),
                _ => return event_pointer.as_ptr(),
            }
            null_mut()
        });
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &handler)
    }
    .ok_or_else(|| io::Error::other("failed to install macOS window event monitor"))?;
    EVENT_MONITOR.with(|slot| *slot.borrow_mut() = Some(monitor));

    let geometry_window = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            publish(&geometry_window);
        }
    });
    publish(window);
    Ok(())
}

/// 将非敏感的原生窗口几何单向下发给 macOS UI 兼容插件，不开放任何页面 IPC 能力。
pub fn publish<R: Runtime>(window: &WebviewWindow<R>) {
    let target = window.clone();
    if let Err(error) = window.run_on_main_thread(move || {
        if let Err(error) = publish_on_main_thread(&target) {
            eprintln!("failed to publish macOS window geometry: {error}");
        }
    }) {
        eprintln!("failed to schedule macOS window geometry update: {error}");
    }
}

pub fn uninstall() {
    EVENT_MONITOR.with(|slot| {
        if let Some(monitor) = slot.borrow_mut().take() {
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
}

fn publish_on_main_thread<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    MainThreadMarker::new()
        .ok_or_else(|| io::Error::other("macOS window geometry must be read on the main thread"))?;
    let ns_window = unsafe {
        window
            .ns_window()?
            .cast::<NSWindow>()
            .as_ref()
            .ok_or_else(|| io::Error::other("main NSWindow is unavailable"))?
    };
    let geometry = serde_json::to_string(&measure_window_chrome(ns_window))?;
    let event = serde_json::to_string(NATIVE_GEOMETRY_EVENT)?;
    let global = serde_json::to_string(NATIVE_GEOMETRY_GLOBAL)?;
    window.eval(format!(
        "(() => {{ const detail = Object.freeze({geometry}); window[{global}] = detail; window.dispatchEvent(new CustomEvent({event}, {{ detail }})); }})();"
    ))?;
    Ok(())
}

fn measure_window_chrome(window: &NSWindow) -> MacosWindowChromeGeometry {
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return MacosWindowChromeGeometry {
            traffic_light_safe_width: 0.0,
            titlebar_height: 0.0,
        };
    }

    let extents = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|kind| {
        let button = window.standardWindowButton(kind)?;
        if button.isHiddenOrHasHiddenAncestor() {
            return None;
        }
        let rect = button.convertRect_toView(button.bounds(), None);
        Some((rect.origin.x, rect.size.width))
    });
    let frame = window.frame();
    let content_layout = window.contentLayoutRect();
    MacosWindowChromeGeometry {
        traffic_light_safe_width: traffic_light_safe_width(extents),
        titlebar_height: titlebar_height(
            frame.size.height,
            content_layout.origin.y,
            content_layout.size.height,
        ),
    }
}

fn traffic_light_safe_width(extents: impl IntoIterator<Item = (f64, f64)>) -> f64 {
    extents
        .into_iter()
        .filter(|(x, width)| x.is_finite() && width.is_finite() && *width > 0.0)
        .map(|(x, width)| x + width)
        .reduce(f64::max)
        .map(|right| (right + TRAFFIC_LIGHT_TRAILING_SAFE_MARGIN).max(0.0))
        .unwrap_or(0.0)
}

fn titlebar_height(window_height: f64, layout_y: f64, layout_height: f64) -> f64 {
    if !window_height.is_finite()
        || !layout_y.is_finite()
        || !layout_height.is_finite()
        || window_height <= 0.0
    {
        return 0.0;
    }
    (window_height - layout_y - layout_height).clamp(0.0, window_height)
}

fn is_titlebar_point(
    x: f64,
    y: f64,
    window_height: f64,
    geometry: MacosWindowChromeGeometry,
) -> bool {
    x >= geometry.traffic_light_safe_width
        && y > (window_height - geometry.titlebar_height).max(0.0)
        && y <= window_height
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_safe_width_from_actual_button_frames_and_trailing_margin() {
        let standard = traffic_light_safe_width([(7.0, 14.0), (27.0, 14.0), (47.0, 14.0)]);
        let shifted = traffic_light_safe_width([(20.0, 14.0), (40.0, 14.0), (60.0, 14.0)]);
        assert_eq!(standard, 72.0);
        assert_eq!(shifted, 85.0);
        assert_eq!(traffic_light_safe_width([]), 0.0);
    }

    #[test]
    fn derives_titlebar_height_from_the_non_obscured_content_rect() {
        assert_eq!(titlebar_height(540.0, 0.0, 512.0), 28.0);
        assert_eq!(titlebar_height(540.0, 0.0, 540.0), 0.0);
        assert_eq!(titlebar_height(f64::NAN, 0.0, 512.0), 0.0);
    }

    #[test]
    fn titlebar_region_uses_measured_window_chrome() {
        let geometry = MacosWindowChromeGeometry {
            traffic_light_safe_width: 72.0,
            titlebar_height: 28.0,
        };
        assert!(is_titlebar_point(72.0, 539.0, 540.0, geometry));
        assert!(!is_titlebar_point(71.9, 539.0, 540.0, geometry));
        assert!(!is_titlebar_point(200.0, 512.0, 540.0, geometry));
        assert!(!is_titlebar_point(200.0, 541.0, 540.0, geometry));
    }
}
