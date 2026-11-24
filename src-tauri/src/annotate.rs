//! The teaching layer: one transparent, click-through window over every monitor
//! where BEV draws its own cursor, boxes, highlights and arrows to show the user
//! things. It never takes focus or clicks, and it's kept out of screenshots so
//! BEV always sees the real screen underneath its drawings.

use crate::error::{BevError, BevResult};
use serde::Serialize;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

fn win(app: &tauri::AppHandle) -> BevResult<WebviewWindow> {
    app.get_webview_window("annotate").ok_or_else(|| BevError::NotFound("annotate window".into()))
}

/// The whole desktop (every monitor) in physical pixels: (left, top, width, height).
fn desktop(w: &WebviewWindow) -> BevResult<(i32, i32, u32, u32)> {
    let monitors = w.available_monitors().map_err(|e| BevError::Os(e.to_string()))?;
    if monitors.is_empty() {
        return Err(BevError::Os("no monitors found".into()));
    }
    let (mut l, mut t, mut r, mut b) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for m in &monitors {
        let p = m.position();
        let s = m.size();
        l = l.min(p.x);
        t = t.min(p.y);
        r = r.max(p.x + s.width as i32);
        b = b.max(p.y + s.height as i32);
    }
    Ok((l, t, (r - l) as u32, (b - t) as u32))
}

#[derive(Serialize)]
pub struct Layer {
    /// Where the layer's top-left sits on the desktop, in physical pixels.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Cover every monitor and show the layer (without stealing focus).
#[tauri::command]
pub fn show_annotate(app: tauri::AppHandle) -> BevResult<Layer> {
    let w = win(&app)?;
    let (x, y, width, height) = desktop(&w)?;
    w.set_position(PhysicalPosition::new(x, y)).map_err(|e| BevError::Os(e.to_string()))?;
    w.set_size(PhysicalSize::new(width, height)).map_err(|e| BevError::Os(e.to_string()))?;
    w.set_always_on_top(true).map_err(|e| BevError::Os(e.to_string()))?;
    w.set_ignore_cursor_events(true).map_err(|e| BevError::Os(e.to_string()))?;
    crate::overlay::exclude_from_capture(&w);
    crate::overlay::show_without_focus(&w)?;
    Ok(Layer { x, y, width, height })
}

#[tauri::command]
pub fn hide_annotate(app: tauri::AppHandle) -> BevResult<()> {
    crate::overlay::hide_window(&win(&app)?)
}

/// Points on the last look_at_screen image → desktop pixels (None for a point off the image).
#[tauri::command]
pub fn shot_points_to_screen(points: Vec<(f64, f64)>) -> BevResult<Vec<Option<(i32, i32)>>> {
    let g = crate::screen::LAST_SHOT
        .lock()
        .ok()
        .and_then(|g| *g)
        .ok_or_else(|| BevError::NotFound("Look at the screen first, then point at things on that screenshot.".into()))?;
    Ok(points.into_iter().map(|(x, y)| crate::control::guard::shot_to_screen(&g, x, y)).collect())
}

pub fn ensure_annotate(app: &tauri::AppHandle) {
    if let Ok(w) = win(app) {
        let _ = w.set_ignore_cursor_events(true);
        crate::overlay::exclude_from_capture(&w);
    }
}
