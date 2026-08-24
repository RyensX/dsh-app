use std::cell::RefCell;
use std::io;
use std::ptr::{null_mut, NonNull};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSWindow};
use tauri::{Runtime, WebviewWindow};

const TITLEBAR_HEIGHT: f64 = 28.0;
const TRAFFIC_LIGHT_SAFE_WIDTH: f64 = 72.0;

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

    // 事件监听只操作 NSWindow；WebView 页面不会收到注入脚本或原生能力。
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
            if !is_titlebar_point(point.x, point.y, event_window.frame().size.height) {
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
    Ok(())
}

pub fn uninstall() {
    EVENT_MONITOR.with(|slot| {
        if let Some(monitor) = slot.borrow_mut().take() {
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
}

fn is_titlebar_point(x: f64, y: f64, window_height: f64) -> bool {
    x >= TRAFFIC_LIGHT_SAFE_WIDTH
        && y > (window_height - TITLEBAR_HEIGHT).max(0.0)
        && y <= window_height
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titlebar_region_excludes_traffic_lights_and_page_content() {
        assert!(is_titlebar_point(72.0, 539.0, 540.0));
        assert!(!is_titlebar_point(71.9, 539.0, 540.0));
        assert!(!is_titlebar_point(200.0, 512.0, 540.0));
        assert!(!is_titlebar_point(200.0, 541.0, 540.0));
    }
}
