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

fn encode(img: RgbaImage, label: String) -> BevResult<ScreenCapture> {
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

/// Capture for the AI. `target`: "current" (the display the mouse is on,
/// default), "primary", or "all" (every display side by side, as arranged).
#[tauri::command]
pub async fn capture_screen(target: Option<String>) -> BevResult<ScreenCapture> {
    // Capture + encode takes ~100-300 ms; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || capture_blocking(target.as_deref().unwrap_or("current")))
        .await
        .map_err(os("capture task"))?
}

fn capture_blocking(target: &str) -> BevResult<ScreenCapture> {
    let monitors = xcap::Monitor::all().map_err(os("monitors"))?;
    if monitors.is_empty() {
        return Err(BevError::NotFound("no displays found".into()));
    }
    let n = monitors.len();
    match target {
        "all" if n > 1 => capture_all(&monitors),
        "primary" => {
            let i = monitors.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0);
            encode(monitors[i].capture_image().map_err(os("capture"))?, describe(&monitors[i], i, n))
        }
        _ => {
            let i = cursor_monitor(&monitors).unwrap_or_else(|| {
                monitors.iter().position(|m| m.is_primary().unwrap_or(false)).unwrap_or(0)
            });
            encode(monitors[i].capture_image().map_err(os("capture"))?, describe(&monitors[i], i, n))
        }
    }
}

/// Stitch every display onto one canvas using their desktop positions.
fn capture_all(monitors: &[xcap::Monitor]) -> BevResult<ScreenCapture> {
    let mut shots = Vec::with_capacity(monitors.len());
    for m in monitors {
        let (x, y) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
        shots.push((x, y, m.capture_image().map_err(os("capture"))?));
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
    encode(canvas, format!("all {} displays side by side", monitors.len()))
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

#[cfg(not(windows))]
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
    fn encode_produces_jpeg() {
        let img = RgbaImage::from_pixel(3000, 1000, image::Rgba([20, 120, 220, 255]));
        let c = encode(img, "test".into()).unwrap();
        assert_eq!((c.width, c.height), (1568, 523));
        let bytes = base64::engine::general_purpose::STANDARD.decode(c.data).unwrap();
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
    }
}
