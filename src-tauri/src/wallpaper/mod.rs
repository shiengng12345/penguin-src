// Live Wallpaper submodule (Extras) — macOS only.
//
// Drops a dedicated hidden webview window (label "penguin-wallpaper") to just
// below the desktop-icon window level so a bundled animated scene renders as
// the desktop background, behind the Finder icons. On non-macOS the commands
// compile and report "macOS-only" — they never create a window.
//
// P2 scope: single (primary) display, bundled scene, enable/disable + status.
// Occlusion/sleep pausing, multi-display, and local-video sources are P3/P4.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const WALLPAPER_LABEL: &str = "penguin-wallpaper";
pub const WALLPAPER_STATUS_EVENT: &str = "wallpaper://status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperStatus {
    /// "disabled" | "running" | "error"  ("paused" arrives in P3).
    pub state: String,
    pub message: Option<String>,
}

impl WallpaperStatus {
    fn disabled(message: Option<&str>) -> Self {
        Self { state: "disabled".into(), message: message.map(str::to_string) }
    }
    fn running() -> Self {
        Self { state: "running".into(), message: None }
    }
    fn error(message: impl Into<String>) -> Self {
        Self { state: "error".into(), message: Some(message.into()) }
    }
}

/// Managed state: the last-known status. The macOS window itself is the source
/// of truth for "running"; this mirrors it for get_status + event payloads.
#[derive(Default)]
pub struct WallpaperManager {
    status: Mutex<Option<WallpaperStatus>>,
}

impl WallpaperManager {
    fn get(&self) -> WallpaperStatus {
        self.status
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| WallpaperStatus::disabled(None))
    }
    fn set(&self, status: WallpaperStatus) {
        *self.status.lock().unwrap() = Some(status);
    }
}

fn emit_status(app: &AppHandle, status: &WallpaperStatus) {
    let _ = app.emit(WALLPAPER_STATUS_EVENT, status.clone());
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub fn wallpaper_get_status(mgr: State<'_, WallpaperManager>) -> Result<WallpaperStatus, String> {
    Ok(mgr.get())
}

#[tauri::command]
pub fn wallpaper_set_enabled(
    app: AppHandle,
    mgr: State<'_, WallpaperManager>,
    enabled: bool,
) -> Result<WallpaperStatus, String> {
    let status = if enabled { platform_enable(&app) } else { platform_disable(&app) };
    mgr.set(status.clone());
    emit_status(&app, &status);
    Ok(status)
}

// ---- macOS implementation -------------------------------------------------

#[cfg(target_os = "macos")]
fn platform_enable(app: &AppHandle) -> WallpaperStatus {
    // Already up? Treat as running (idempotent enable).
    if app.get_webview_window(WALLPAPER_LABEL).is_some() {
        return WallpaperStatus::running();
    }
    // `wallpaper_set_enabled` is a sync #[tauri::command], which Tauri runs on
    // the MAIN thread (same as inline_webview_open, which builds native
    // webviews directly). So we build + configure the NSWindow inline here.
    // Do NOT dispatch via run_on_main_thread and block on the result: we're
    // already on the main thread, so queuing work onto it while blocking it
    // would deadlock.
    build_and_configure(app)
}

#[cfg(target_os = "macos")]
fn build_and_configure(app: &AppHandle) -> WallpaperStatus {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let window = match WebviewWindowBuilder::new(
        app,
        WALLPAPER_LABEL,
        WebviewUrl::App("wallpaper/default.html".into()),
    )
    .decorations(false)
    .resizable(false)
    .focusable(false)
    .shadow(false)
    .visible(false)
    .build()
    {
        Ok(w) => w,
        Err(e) => return WallpaperStatus::error(format!("wallpaper window build failed: {e}")),
    };

    match unsafe { configure_desktop_window(&window) } {
        Ok(()) => WallpaperStatus::running(),
        Err(e) => {
            let _ = window.close();
            WallpaperStatus::error(e)
        }
    }
}

/// SAFETY: must run on the main thread; `win` must own a live NSWindow.
#[cfg(target_os = "macos")]
unsafe fn configure_desktop_window(win: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSColor, NSScreen, NSWindow, NSWindowCollectionBehavior};
    use objc2_core_graphics::{CGWindowLevelForKey, CGWindowLevelKey};
    use objc2_foundation::MainThreadMarker;

    let ptr = win.ns_window().map_err(|e| format!("ns_window: {e}"))? as *mut NSWindow;
    if ptr.is_null() {
        return Err("null ns_window".into());
    }
    let window: &NSWindow = &*ptr;
    let mtm = MainThreadMarker::new().ok_or("configure_desktop_window off main thread")?;

    // Just below the desktop-icon level: behind the icons, above the static
    // wallpaper picture. Computed at runtime — never hard-code the integer.
    let level = (CGWindowLevelForKey(CGWindowLevelKey::DesktopIconWindowLevelKey) - 1) as isize;
    window.setLevel(level);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenNone,
    );
    window.setIgnoresMouseEvents(true);
    window.setHasShadow(false);
    window.setOpaque(true);
    let black = NSColor::blackColor();
    window.setBackgroundColor(Some(&black));

    // Cover the whole primary screen (AppKit points; frame, not visibleFrame).
    if let Some(screen) = NSScreen::mainScreen(mtm) {
        window.setFrame_display(screen.frame(), true);
    }

    window.orderFrontRegardless();
    Ok(())
}

// ---- non-macOS stubs ------------------------------------------------------

#[cfg(not(target_os = "macos"))]
fn platform_enable(_app: &AppHandle) -> WallpaperStatus {
    WallpaperStatus::disabled(Some("Live wallpaper is macOS-only"))
}

#[cfg(not(target_os = "macos"))]
fn platform_disable(_app: &AppHandle) -> WallpaperStatus {
    WallpaperStatus::disabled(None)
}

#[cfg(target_os = "macos")]
fn platform_disable(app: &AppHandle) -> WallpaperStatus {
    if let Some(win) = app.get_webview_window(WALLPAPER_LABEL) {
        let _ = win.close();
    }
    WallpaperStatus::disabled(None)
}
