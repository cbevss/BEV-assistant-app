//! Screen awareness: capture what the user is looking at so the AI can see it,
//! and report the foreground window. Images are downscaled and JPEG-encoded in
//! memory (never written to disk) and returned to the webview as base64.
//! The BEV overlay is excluded from capture (see overlay.rs), so the orb never
//! covers what BEV is trying to see.

use crate::error::{BevError, BevResult};
use base64::Engine;
use image::{imageops::FilterType, DynamicImage, RgbaImage};
use serde::Serialize;

/// Long-edge limit: vision APIs downscale anything larger, so sending more just
/// costs upload time and tokens.
const MAX_EDGE: u32 = 1568;
const JPEG_QUALITY: u8 = 80;

#[derive(Serialize)]
pub struct ScreenCapture {
    /// Base64 JPEG.
    pub data: String,
    pub width: u32,
    pub height: u32,
    /// Which display(s) this covers, for the model's benefit.
    pub label: String,
}

#[derive(Serialize)]
pub struct ForegroundWindow {
    pub title: String,
    /// Executable name, e.g. "chrome.exe".
    pub process: String,
}

fn os<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> BevError {
    move |e| BevError::Os(format!("{what}: {e}"))
}

/// Fit within MAX_EDGE on the long side, keeping aspect ratio.
pub(crate) fn fit(w: u32, h: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= MAX_EDGE || long == 0 {
        return (w.max(1), h.max(1));
    }
    let s = MAX_EDGE as f64 / long as f64;
    (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1))
}

pub(crate) fn encode(img: RgbaImage, label: String) -> BevResult<ScreenCapture> {
    let (w, h) = fit(img.width(), img.height());
    let rgb = DynamicImage::ImageRgba8(img).resize_exact(w, h, FilterType::Triangle).to_rgb8();
    let mut buf = Vec::with_capacity(256 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(os("encode"))?;
    Ok(ScreenCapture {
        data: base64::engine::general_purpose::STANDARD.encode(&buf),
        width: w,
        height: h,
        label,
    })
}

fn describe(m: &xcap::Monitor, idx: usize, total: usize) -> String {
    let primary = if m.is_primary().unwrap_or(false) { ", primary" } else { "" };
    format!("display {} of {total}{primary}", idx + 1)
}

/// Capture for the AI. `target`: "auto" (every display if there are several,
/// default), "current" (the display the mouse is on), "primary", "all", or
/// "window:<hwnd>" (one window close up, on whichever display it's on).
#[tauri::command]
pub async fn capture_screen(target: Option<String>) -> BevResult<ScreenCapture> {
    // Capture + encode takes ~100-300 ms; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || capture_blocking(target.as_deref().unwrap_or("auto")))
        .await
        .map_err(os("capture task"))?
}

fn capture_blocking(target: &str) -> BevResult<ScreenCapture> {
    let (img, ox, oy, label) = capture_raw(target)?;
    let (w, h) = fit(img.width(), img.height());
    if let Ok(mut g) = LAST_SHOT.lock() {
        *g = Some(crate::control::guard::ShotGeom { origin_x: ox, origin_y: oy, src_w: img.width(), src_h: img.height(), img_w: w, img_h: h });
    }
    encode(img, label)
}

/// One frame of the phone's live video: the screen scaled to `max_edge`, as raw
/// JPEG bytes (no base64), quickly. Doesn't touch LAST_SHOT, so BEV's own
/// clicking keeps using the screenshots it actually looked at.
#[tauri::command]
pub async fn live_frame(target: Option<String>, max_edge: Option<u32>, quality: Option<u8>) -> BevResult<tauri::ipc::Response> {
    let edge = max_edge.unwrap_or(1600).clamp(480, 2560);
    let q = quality.unwrap_or(72).clamp(40, 92);
    tauri::async_runtime::spawn_blocking(move || -> BevResult<tauri::ipc::Response> {
        let (img, _, _, _) = capture_raw(target.as_deref().unwrap_or("current"))?;
        let bytes = live_jpeg(img, edge, q)?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(os("live frame task"))?
}

/// Fast downscale (box-filter thumbnail) + JPEG. Pure; tested.
pub(crate) fn live_jpeg(img: RgbaImage, edge: u32, quality: u8) -> BevResult<Vec<u8>> {
    let (w, h) = (img.width(), img.height());
    let long = w.max(h).max(1);
    let small = if long > edge {
        let s = edge as f64 / long as f64;
        image::imageops::thumbnail(&img, ((w as f64 * s) as u32).max(2) & !1, ((h as f64 * s) as u32).max(2) & !1)
    } else {
        img
    };
    let rgb = DynamicImage::ImageRgba8(small).to_rgb8();
    let mut buf = Vec::with_capacity(200 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality).encode_image(&rgb).map_err(os("encode"))?;
    Ok(buf)
}

/// Where the last screenshot sent to the AI came from, so a point the AI picks
/// on it can be mapped back to the desktop.
pub(crate) static LAST_SHOT: std::sync::Mutex<Option<crate::control::guard::ShotGeom>> = std::sync::Mutex::new(None);

/// Capture one monitor. On KDE Wayland, KWin's own screenshot interface is
/// tried first (silent, no portal prompt); xcap is the fallback.
pub(crate) fn grab(m: &xcap::Monitor) -> BevResult<RgbaImage> {
    #[cfg(target_os = "linux")]
    if let Ok(name) = m.name() {
        if let Ok(img) = crate::kwin::capture_screen(&name) {
            return Ok(img);
        }
    }
    m.capture_image().map_err(|e| BevError::Os(format!("capture: {e}")))
}

/// Full-resolution capture plus its top-left desktop position.
pub(crate) fn capture_raw(target: &str) -> BevResult<(RgbaImage, i32, i32, String)> {
    let monitors = xcap::Monitor::all().map_err(os("monitors"))?;
    if monitors.is_empty() {
        return Err(BevError::NotFound("no displays found".into()));
    }
    let n = monitors.len();
    let one = |i: usize| -> BevResult<(RgbaImage, i32, i32, String)> {
        let m = &monitors[i];
        Ok((grab(m)?, m.x().unwrap_or(0), m.y().unwrap_or(0), describe(m, i, n)))
    };
    if let Some(h) = target.strip_prefix("window:").and_then(|h| h.parse::<isize>().ok()) {
        return capture_window(h);
    }
    match target {
        // auto: every display when there's more than one, so nothing is out of sight.
        "all" | "auto" if n > 1 => capture_all(&monitors),
        "primary" => one(monitors.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0)),
        _ => one(cursor_monitor(&monitors).unwrap_or_else(|| monitors.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0))),
    }
}

/// "display N of M" for the display containing a desktop point.
pub(crate) fn display_label_at(x: i32, y: i32) -> Option<String> {
    let monitors = xcap::Monitor::all().ok()?;
    let n = monitors.len();
    monitors.iter().enumerate().find_map(|(i, m)| {
        let (mx, my) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
        let (w, h) = (m.width().unwrap_or(0) as i32, m.height().unwrap_or(0) as i32);
        (x >= mx && x < mx + w && y >= my && y < my + h).then(|| describe(m, i, n))
    })
}

/// One window, cropped from the display it's on (any display). Errors if it's
/// minimised or off screen, so the caller can restore it first.
pub(crate) fn capture_window(hwnd: isize) -> BevResult<(RgbaImage, i32, i32, String)> {
    let r = crate::control::win::window_rect(hwnd).ok_or_else(|| BevError::NotFound("that window has closed".into()))?;
    if r.minimized {
        return Err(BevError::Invalid("that window is minimised: bring it forward with focus_window first".into()));
    }
    let (cx, cy) = ((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    let label = display_label_at(cx, cy).unwrap_or_default();
    let (full, mx, my) = capture_at(cx, cy)?;
    let (l, t) = ((r.left - mx).max(0) as u32, (r.top - my).max(0) as u32);
    let (rr, bb) = (((r.right - mx).max(0) as u32).min(full.width()), ((r.bottom - my).max(0) as u32).min(full.height()));
    if rr <= l + 4 || bb <= t + 4 {
        return Err(BevError::Invalid("that window isn't on screen".into()));
    }
    let crop = image::imageops::crop_imm(&full, l, t, rr - l, bb - t).to_image();
    Ok((crop, mx + l as i32, my + t as i32, format!("{} window on {label}", r.title)))
}

/// Capture the display containing a desktop point (for cropping to a window).
pub(crate) fn capture_at(x: i32, y: i32) -> BevResult<(RgbaImage, i32, i32)> {
    let monitors = xcap::Monitor::all().map_err(os("monitors"))?;
    let m = monitors
        .iter()
        .find(|m| {
            let (mx, my) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
            let (w, h) = (m.width().unwrap_or(0) as i32, m.height().unwrap_or(0) as i32);
            x >= mx && x < mx + w && y >= my && y < my + h
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| BevError::NotFound("no displays found".into()))?;
    Ok((grab(m)?, m.x().unwrap_or(0), m.y().unwrap_or(0)))
}

/// Stitch every display onto one canvas using their desktop positions.
fn capture_all(monitors: &[xcap::Monitor]) -> BevResult<(RgbaImage, i32, i32, String)> {
    let mut shots = Vec::with_capacity(monitors.len());
    for m in monitors {
        let (x, y) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
        shots.push((x, y, grab(m)?));
    }
    let min_x = shots.iter().map(|s| s.0).min().unwrap_or(0);
    let min_y = shots.iter().map(|s| s.1).min().unwrap_or(0);
    let max_x = shots.iter().map(|s| s.0 + s.2.width() as i32).max().unwrap_or(1);
    let max_y = shots.iter().map(|s| s.1 + s.2.height() as i32).max().unwrap_or(1);
    let (cw, ch) = ((max_x - min_x).max(1) as u32, (max_y - min_y).max(1) as u32);
    // Guard against absurd layouts (e.g. bogus coordinates) eating memory.
    if (cw as u64) * (ch as u64) > 120_000_000 {
        return Err(BevError::Invalid("display layout too large to capture at once".into()));
    }
    let mut canvas = RgbaImage::new(cw, ch);
    for (x, y, img) in &shots {
        image::imageops::overlay(&mut canvas, img, (x - min_x) as i64, (y - min_y) as i64);
    }
    Ok((canvas, min_x, min_y, format!("all {} displays side by side", monitors.len())))
}

#[cfg(windows)]
fn cursor_monitor(monitors: &[xcap::Monitor]) -> Option<usize> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p).ok()? };
    monitors.iter().position(|m| {
        let (x, y) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
        let (w, h) = (m.width().unwrap_or(0) as i32, m.height().unwrap_or(0) as i32);
        p.x >= x && p.x < x + w && p.y >= y && p.y < y + h
    })
}

#[cfg(not(windows))]
fn cursor_monitor(_m: &[xcap::Monitor]) -> Option<usize> {
    None
}

/// Title and executable of the window the user is currently using.
#[tauri::command]
pub fn foreground_window() -> BevResult<Option<ForegroundWindow>> {
    imp::foreground()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    pub fn foreground() -> BevResult<Option<ForegroundWindow>> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return Ok(None);
            }
            let len = GetWindowTextLengthW(hwnd);
            let title = if len > 0 {
                let mut buf = vec![0u16; (len + 1) as usize];
                let got = GetWindowTextW(hwnd, &mut buf);
                String::from_utf16_lossy(&buf[..got.max(0) as usize])
            } else {
                String::new()
            };
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            let mut process = String::new();
            if pid != 0 {
                if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    let mut buf = vec![0u16; 1024];
                    let mut size = buf.len() as u32;
                    if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok() {
                        let full = String::from_utf16_lossy(&buf[..size as usize]);
                        process = full.rsplit(['\\', '/']).next().unwrap_or("").to_string();
                    }
                    let _ = CloseHandle(h);
                }
            }
            if title.is_empty() && process.is_empty() {
                return Ok(None);
            }
            Ok(Some(ForegroundWindow { title, process }))
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    pub fn foreground() -> BevResult<Option<ForegroundWindow>> {
        Ok(crate::control::win::foreground().map(|w| ForegroundWindow { title: w.title, process: w.process }))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::*;
    pub fn foreground() -> BevResult<Option<ForegroundWindow>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_small_images() {
        assert_eq!(fit(1280, 720), (1280, 720));
    }

    #[test]
    fn fit_scales_long_edge() {
        assert_eq!(fit(2560, 1440), (1568, 882));
        assert_eq!(fit(1440, 2560), (882, 1568));
        assert_eq!(fit(5120, 1440), (1568, 441));
    }

    #[test]
    fn live_jpeg_scales_down_to_even_size() {
        let img = RgbaImage::from_pixel(2561, 1441, image::Rgba([10, 20, 30, 255]));
        let bytes = live_jpeg(img, 1280, 70).unwrap();
        let back = image::load_from_memory(&bytes).unwrap();
        assert!(back.width() <= 1280 && back.width() % 2 == 0 && back.height() % 2 == 0);
    }

    #[test]
    fn encode_produces_jpeg() {
        let img = RgbaImage::from_pixel(3000, 1000, image::Rgba([20, 120, 220, 255]));
        let c = encode(img, "test".into()).unwrap();
        assert_eq!((c.width, c.height), (1568, 523));
        let bytes = base64::engine::general_purpose::STANDARD.decode(c.data).unwrap();
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
    }
}
