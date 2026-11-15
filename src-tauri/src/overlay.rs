//! Overlay window control: show/hide, click-through toggling, repositioning.
//! The overlay is always-on-top and skips the taskbar. It is always
//! click-through: it only displays the orb, so clicks go to whatever is behind.
//! It never takes focus either: it is shown without activation, so a game (or
//! anything else) keeps the keyboard and mouse while BEV is on screen.

use crate::error::{BevError, BevResult};
use tauri::{Manager, WebviewWindow};

fn overlay_win(app: &tauri::AppHandle) -> BevResult<WebviewWindow> {
    app.get_webview_window("overlay")
        .ok_or_else(|| BevError::NotFound("overlay window".into()))
}

pub fn ensure_overlay(app: &tauri::AppHandle) -> BevResult<()> {
    let w = overlay_win(app)?;
    // Start transparent, click-through, hidden.
    w.set_ignore_cursor_events(true)
        .map_err(|e| BevError::Os(e.to_string()))?;
    exclude_from_capture(&w);
    Ok(())
}

/// Keep the orb out of screenshots (BEV's own screen captures included), so it
/// never hides what BEV is looking at. Windows 10 2004+; silently a no-op before.
#[cfg(windows)]
fn exclude_from_capture(w: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    if let Ok(h) = w.hwnd() {
        // Tauri may use a different `windows` crate version; go via the raw handle.
        let hwnd = HWND(h.0 as *mut _);
        if let Err(e) = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) } {
            log::warn!("overlay capture exclusion unavailable: {e}");
        }
    }
}

#[cfg(not(windows))]
fn exclude_from_capture(_w: &WebviewWindow) {}

#[tauri::command]
pub fn show_overlay(app: tauri::AppHandle) -> BevResult<()> {
    let w = overlay_win(&app)?;
    // Style changes first: Tauri re-applies window styles on these calls.
    w.set_always_on_top(true)
        .map_err(|e| BevError::Os(e.to_string()))?;
    // Re-apply on every show, so the popup never blocks clicks behind it.
    w.set_ignore_cursor_events(true)
        .map_err(|e| BevError::Os(e.to_string()))?;
    show_without_focus(&w)
}

#[tauri::command]
pub fn hide_overlay(app: tauri::AppHandle) -> BevResult<()> {
    hide_window(&overlay_win(&app)?)
}

/// Tauri's show() activates the window, which pulls focus out of a game
/// (stutter, alt-tab, mouse escaping). Show it the way tooltips are shown.
/// Hide goes the same way so Tauri's idea of visibility can't get out of step.
#[cfg(windows)]
fn show_without_focus(w: &WebviewWindow) -> BevResult<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
        SW_SHOWNOACTIVATE,
    };
    let h = w.hwnd().map_err(|e| BevError::Os(e.to_string()))?;
    let hwnd = HWND(h.0 as *mut _);
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
    }
    Ok(())
}

#[cfg(windows)]
fn hide_window(w: &WebviewWindow) -> BevResult<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    let h = w.hwnd().map_err(|e| BevError::Os(e.to_string()))?;
    unsafe {
        let _ = ShowWindow(HWND(h.0 as *mut _), SW_HIDE);
    }
    Ok(())
}

#[cfg(not(windows))]
fn show_without_focus(w: &WebviewWindow) -> BevResult<()> {
    w.show().map_err(|e| BevError::Os(e.to_string()))
}

#[cfg(not(windows))]
fn hide_window(w: &WebviewWindow) -> BevResult<()> {
    w.hide().map_err(|e| BevError::Os(e.to_string()))
}

/// What's in front: "exclusive" = a game owns the display (exclusive
/// fullscreen, where drawing anything on top can kick it out of fullscreen),
/// "borderless" = a window covering its whole monitor (borderless/windowed
/// fullscreen games, fullscreen video), "none" = normal desktop use.
#[tauri::command]
pub fn fullscreen_state() -> &'static str {
    fullscreen::detect()
}

#[cfg(windows)]
mod fullscreen {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowRect, GetWindowThreadProcessId,
    };

    pub fn detect() -> &'static str {
        unsafe {
            if let Ok(state) = SHQueryUserNotificationState() {
                if state == QUNS_RUNNING_D3D_FULL_SCREEN {
                    return "exclusive";
                }
            }
            let fg = GetForegroundWindow();
            if fg.0.is_null() || fg == GetShellWindow() || fg == GetDesktopWindow() {
                return "none";
            }
            // BEV's own windows never count.
            let mut pid = 0u32;
            GetWindowThreadProcessId(fg, Some(&mut pid as *mut u32));
            if pid == std::process::id() {
                return "none";
            }
            let mut cls = [0u16; 64];
            let n = GetClassNameW(fg, &mut cls);
            let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
            if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
                return "none";
            }
            let mut r = RECT::default();
            if GetWindowRect(fg, &mut r).is_err() {
                return "none";
            }
            let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(mon, &mut mi).as_bool() {
                return "none";
            }
            let m = mi.rcMonitor;
            if r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom {
                "borderless"
            } else {
                "none"
            }
        }
    }
}

#[cfg(not(windows))]
mod fullscreen {
    pub fn detect() -> &'static str {
        "none"
    }
}

#[tauri::command]
pub fn set_overlay_clickthrough(app: tauri::AppHandle, ignore: bool) -> BevResult<()> {
    let w = overlay_win(&app)?;
    keep_visible(&w, |w| w.set_ignore_cursor_events(ignore).map_err(|e| BevError::Os(e.to_string())))
}

/// Because the orb is shown directly (above), Tauri believes it is hidden, and
/// its window-style updates re-hide it. Run such calls through here while the
/// orb may be on screen: it is put back, still without taking focus.
fn keep_visible(w: &WebviewWindow, f: impl FnOnce(&WebviewWindow) -> BevResult<()>) -> BevResult<()> {
    let was = is_shown(w);
    let r = f(w);
    if was {
        show_without_focus(w)?;
    }
    r
}

#[cfg(windows)]
fn is_shown(w: &WebviewWindow) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    w.hwnd().map(|h| unsafe { IsWindowVisible(HWND(h.0 as *mut _)).as_bool() }).unwrap_or(false)
}

#[cfg(not(windows))]
fn is_shown(w: &WebviewWindow) -> bool {
    w.is_visible().unwrap_or(false)
}

/// Place the overlay in a corner of the chosen monitor at `size_logical`
/// (pre-DPI) pixels. Uses Tauri's own monitor list so DPI scaling is honoured.
#[tauri::command]
pub fn place_overlay(
    app: tauri::AppHandle,
    corner: String,
    size_logical: f64,
    monitor: Option<usize>,
) -> BevResult<()> {
    let w = overlay_win(&app)?;
    let monitors = w.available_monitors().map_err(|e| BevError::Os(e.to_string()))?;
    let m = match monitor.and_then(|i| monitors.get(i).cloned()) {
        Some(m) => m,
        None => w
            .primary_monitor()
            .map_err(|e| BevError::Os(e.to_string()))?
            .or_else(|| monitors.first().cloned())
            .ok_or_else(|| BevError::NotFound("no monitor".into()))?,
    };
    let scale = m.scale_factor();
    let size = (size_logical.clamp(160.0, 900.0) * scale).round() as i32;
    let margin = (24.0 * scale).round() as i32;
    let pos = m.position();
    let dim = m.size();
    let (mw, mh) = (dim.width as i32, dim.height as i32);
    let (x, y) = match corner.as_str() {
        "top-left" => (pos.x + margin, pos.y + margin),
        "bottom-left" => (pos.x + margin, pos.y + mh - size - margin * 3),
        "bottom-right" => (pos.x + mw - size - margin, pos.y + mh - size - margin * 3),
        "center" => (pos.x + (mw - size) / 2, pos.y + (mh - size) / 2),
        _ => (pos.x + mw - size - margin, pos.y + margin), // top-right default
    };
    keep_visible(&w, |w| {
        w.set_size(tauri::PhysicalSize::new(size as u32, size as u32))
            .map_err(|e| BevError::Os(e.to_string()))?;
        w.set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| BevError::Os(e.to_string()))
    })
}

#[tauri::command]
pub fn set_overlay_position(app: tauri::AppHandle, x: i32, y: i32) -> BevResult<()> {
    let w = overlay_win(&app)?;
    keep_visible(&w, |w| w.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| BevError::Os(e.to_string())))
}
