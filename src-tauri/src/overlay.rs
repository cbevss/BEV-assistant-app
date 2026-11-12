//! Overlay window control: show/hide, click-through toggling, repositioning.
//! The overlay is always-on-top and skips the taskbar; click-through is on by
//! default so it never steals input until the UI asks for interaction.

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
    Ok(())
}

#[tauri::command]
pub fn show_overlay(app: tauri::AppHandle) -> BevResult<()> {
    let w = overlay_win(&app)?;
    w.show().map_err(|e| BevError::Os(e.to_string()))?;
    w.set_always_on_top(true)
        .map_err(|e| BevError::Os(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn hide_overlay(app: tauri::AppHandle) -> BevResult<()> {
    overlay_win(&app)?
        .hide()
        .map_err(|e| BevError::Os(e.to_string()))
}

#[tauri::command]
pub fn set_overlay_clickthrough(app: tauri::AppHandle, ignore: bool) -> BevResult<()> {
    overlay_win(&app)?
        .set_ignore_cursor_events(ignore)
        .map_err(|e| BevError::Os(e.to_string()))
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
    w.set_size(tauri::PhysicalSize::new(size as u32, size as u32))
        .map_err(|e| BevError::Os(e.to_string()))?;
    w.set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| BevError::Os(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn set_overlay_position(app: tauri::AppHandle, x: i32, y: i32) -> BevResult<()> {
    overlay_win(&app)?
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| BevError::Os(e.to_string()))
}
