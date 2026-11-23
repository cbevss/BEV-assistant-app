//! Vision and control: read apps' controls (UI Automation), read on-screen text
//! (Windows OCR, on this PC) and, when needed, press keys, type and click.
//!
//! Safety limits are enforced here, natively, so nothing on screen or in a web
//! page can talk BEV past them: no typing into terminals, the Run box, Start
//! search or the Registry Editor; never into password boxes; no Win+R/Win+X;
//! no input into an exclusive-fullscreen game.

pub mod elements;
pub mod guard;
pub mod input;
pub mod keys;
#[cfg(target_os = "linux")]
pub mod portal;
pub mod ocr;
pub mod recorder;
pub mod uia;
pub mod win;

use crate::error::{BevError, BevResult};
use serde::Serialize;

fn msg(s: impl Into<String>) -> BevError {
    BevError::Message(s.into())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> BevResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| BevError::Os(format!("task: {e}")))?.map_err(msg)
}

#[tauri::command]
pub async fn ui_read(hwnd: Option<i64>) -> BevResult<uia::UiSnapshot> {
    blocking(move || uia::read(hwnd.map(|h| h as isize))).await
}

#[tauri::command]
pub async fn ui_act(id: usize, action: String, text: Option<String>) -> BevResult<uia::ActResult> {
    blocking(move || uia::act(id, action, text)).await
}

#[tauri::command]
pub async fn screen_ocr(target: Option<String>) -> BevResult<ocr::OcrResult> {
    let t = target.unwrap_or_else(|| "window".into());
    tauri::async_runtime::spawn_blocking(move || ocr::read(&t)).await.map_err(|e| BevError::Os(format!("task: {e}")))?
}

#[derive(Serialize)]
pub struct InputTarget {
    pub title: String,
    pub process: String,
    /// The window's handle, so BEV can bring it back to the front.
    pub hwnd: isize,
}

/// Checks before any synthetic keystroke: a window to receive it, not BEV
/// itself, not a game, not a place where typed text runs as a command.
fn keyboard_target() -> Result<win::WinInfo, String> {
    if let Some(why) = guard::game_blocks_input(crate::overlay::fullscreen_state()) {
        return Err(why.into());
    }
    let fg = win::foreground().ok_or("There's no window in front to send keys to.")?;
    if fg.is_bev() {
        return Err("BEV's own window is in front. Say which app to use (BEV can switch to it first).".into());
    }
    if let Some(why) = guard::typing_blocked(&fg.process, &fg.class, &fg.title) {
        return Err(why);
    }
    Ok(fg)
}

#[tauri::command]
pub async fn input_keys(keys: String) -> BevResult<InputTarget> {
    blocking(move || {
        let combos = keys::parse_sequence(&keys)?;
        for c in &combos {
            if let Some(why) = guard::blocked_combo(c) {
                return Err(why.into());
            }
        }
        let fg = keyboard_target()?;
        input::press(&combos)?;
        Ok(InputTarget { title: fg.title, process: fg.process, hwnd: fg.hwnd })
    })
    .await
}

#[tauri::command]
pub async fn input_type(text: String) -> BevResult<InputTarget> {
    blocking(move || {
        if text.is_empty() {
            return Err("nothing to type".into());
        }
        if text.chars().count() > 5000 {
            return Err("that's too much to type at once (5000 characters max)".into());
        }
        let fg = keyboard_target()?;
        if uia::focused_is_password().unwrap_or(false) {
            return Err("The cursor is in a password box. BEV never types passwords: please enter it yourself.".into());
        }
        input::type_text(&text)?;
        Ok(InputTarget { title: fg.title, process: fg.process, hwnd: fg.hwnd })
    })
    .await
}

#[derive(Serialize)]
pub struct ClickResult {
    pub x: i32,
    pub y: i32,
    /// What was under the pointer, if UI Automation could tell.
    pub target: Option<uia::PointInfo>,
}

/// Click a point. `space`: "screen" (desktop pixels) or "screenshot"
/// (a point on the last image from look_at_screen).
#[tauri::command]
pub async fn input_click(x: f64, y: f64, space: Option<String>, button: Option<String>, double: Option<bool>) -> BevResult<ClickResult> {
    blocking(move || {
        if let Some(why) = guard::game_blocks_input(crate::overlay::fullscreen_state()) {
            return Err(why.into());
        }
        let (sx, sy) = if space.as_deref() == Some("screenshot") {
            let g = crate::screen::LAST_SHOT.lock().ok().and_then(|g| *g).ok_or("Look at the screen first, then pick a point on that screenshot.")?;
            guard::shot_to_screen(&g, x, y).ok_or("That point is outside the last screenshot.")?
        } else {
            (x.round() as i32, y.round() as i32)
        };
        let target = uia::element_at(sx, sy).ok().flatten();
        if let Some(t) = &target {
            if t.process.eq_ignore_ascii_case(&std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_default()) {
                return Err("That point is on BEV's own window.".into());
            }
        }
        input::click(sx, sy, button.as_deref() == Some("right"), double.unwrap_or(false))?;
        Ok(ClickResult { x: sx, y: sy, target })
    })
    .await
}

/// A point in "screen" (desktop pixels) or "screenshot" (last look_at_screen image) space.
fn resolve_point(x: f64, y: f64, space: Option<&str>) -> Result<(i32, i32), String> {
    if space == Some("screenshot") {
        let g = crate::screen::LAST_SHOT.lock().ok().and_then(|g| *g).ok_or("Look at the screen first, then pick a point on that screenshot.")?;
        guard::shot_to_screen(&g, x, y).ok_or_else(|| "That point is outside the last screenshot.".to_string())
    } else {
        Ok((x.round() as i32, y.round() as i32))
    }
}

/// Refuse points on BEV's own windows and input into fullscreen games.
fn pointer_allowed(sx: i32, sy: i32) -> Result<Option<uia::PointInfo>, String> {
    if let Some(why) = guard::game_blocks_input(crate::overlay::fullscreen_state()) {
        return Err(why.into());
    }
    let target = uia::element_at(sx, sy).ok().flatten();
    let me = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_default();
    if target.as_ref().is_some_and(|t| t.process.eq_ignore_ascii_case(&me)) {
        return Err("That point is on BEV's own window.".into());
    }
    Ok(target)
}

/// Scroll the mouse wheel over a point. `amount` is wheel notches (1–30);
/// direction "up" | "down" | "left" | "right".
#[tauri::command]
pub async fn input_scroll(x: Option<f64>, y: Option<f64>, space: Option<String>, direction: String, amount: Option<i32>) -> BevResult<ClickResult> {
    blocking(move || {
        // No point given: the middle of what BEV last looked at, else wherever the pointer is.
        let (sx, sy) = match (x, y) {
            (Some(x), Some(y)) => resolve_point(x, y, space.as_deref())?,
            _ => crate::screen::LAST_SHOT
                .lock()
                .ok()
                .and_then(|g| *g)
                .map(|g| (g.origin_x + g.src_w as i32 / 2, g.origin_y + g.src_h as i32 / 2))
                .or_else(input::cursor_pos)
                .ok_or("Say where to scroll: look at the screen first, or give x and y.")?,
        };
        let target = pointer_allowed(sx, sy)?;
        let n = amount.unwrap_or(5).clamp(1, 30);
        let (notches, horizontal) = match direction.as_str() {
            "up" => (n, false),
            "down" => (-n, false),
            "right" => (n, true),
            "left" => (-n, true),
            other => return Err(format!("unknown scroll direction \"{other}\" (up, down, left or right)")),
        };
        input::scroll(sx, sy, notches, horizontal)?;
        Ok(ClickResult { x: sx, y: sy, target })
    })
    .await
}

/// Rest the pointer on a point (hover menus, tooltips).
#[tauri::command]
pub async fn input_hover(x: f64, y: f64, space: Option<String>) -> BevResult<ClickResult> {
    blocking(move || {
        let (sx, sy) = resolve_point(x, y, space.as_deref())?;
        let target = pointer_allowed(sx, sy)?;
        input::hover(sx, sy)?;
        Ok(ClickResult { x: sx, y: sy, target })
    })
    .await
}

/// Drag from one point to another with the left button (sliders, drag and drop).
#[tauri::command]
pub async fn input_drag(from_x: f64, from_y: f64, to_x: f64, to_y: f64, space: Option<String>) -> BevResult<ClickResult> {
    blocking(move || {
        let from = resolve_point(from_x, from_y, space.as_deref())?;
        let to = resolve_point(to_x, to_y, space.as_deref())?;
        let target = pointer_allowed(from.0, from.1)?;
        pointer_allowed(to.0, to.1)?;
        input::drag(from, to)?;
        Ok(ClickResult { x: to.0, y: to.1, target })
    })
    .await
}

/// What's under a point, so the app can ask before clicking something risky.
#[tauri::command]
pub async fn point_info(x: f64, y: f64, space: Option<String>) -> BevResult<Option<uia::PointInfo>> {
    blocking(move || {
        let (sx, sy) = if space.as_deref() == Some("screenshot") {
            let Some(g) = crate::screen::LAST_SHOT.lock().ok().and_then(|g| *g) else { return Ok(None) };
            match guard::shot_to_screen(&g, x, y) {
                Some(p) => p,
                None => return Ok(None),
            }
        } else {
            (x.round() as i32, y.round() as i32)
        };
        uia::element_at(sx, sy)
    })
    .await
}

/// The window keys would go to (for the app's confirmation checks).
#[tauri::command]
pub fn input_target() -> Option<InputTarget> {
    win::foreground().filter(|w| !w.is_bev()).map(|w| InputTarget { title: w.title, process: w.process, hwnd: w.hwnd })
}
