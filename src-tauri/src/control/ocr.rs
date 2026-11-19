//! On-device text recognition with Windows' built-in OCR (Windows.Media.Ocr).
//! Nothing leaves the PC: this is the private alternative to sending a
//! screenshot to an AI provider when BEV only needs the words.

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct OcrWord {
    pub text: String,
    /// x, y, width, height in desktop pixels.
    pub rect: [i32; 4],
}

#[derive(Debug, Serialize, Clone)]
pub struct OcrLine {
    pub text: String,
    pub rect: [i32; 4],
    pub words: Vec<OcrWord>,
}

#[derive(Debug, Serialize)]
pub struct OcrResult {
    pub source: String,
    pub lines: Vec<OcrLine>,
}

/// Bounding box of several boxes.
pub fn union(rects: &[[i32; 4]]) -> [i32; 4] {
    if rects.is_empty() {
        return [0, 0, 0, 0];
    }
    let l = rects.iter().map(|r| r[0]).min().unwrap();
    let t = rects.iter().map(|r| r[1]).min().unwrap();
    let r = rects.iter().map(|r| r[0] + r[2]).max().unwrap();
    let b = rects.iter().map(|r| r[1] + r[3]).max().unwrap();
    [l, t, r - l, b - t]
}

/// A box on the (possibly scaled) OCR image → desktop pixels.
pub fn to_desktop(x: f32, y: f32, w: f32, h: f32, scale: f64, ox: i32, oy: i32) -> [i32; 4] {
    let s = if scale <= 0.0 { 1.0 } else { scale };
    [
        ox + (x as f64 / s).round() as i32,
        oy + (y as f64 / s).round() as i32,
        (w as f64 / s).round() as i32,
        (h as f64 / s).round() as i32,
    ]
}

#[cfg(windows)]
mod imp {
    use super::super::{guard, win};
    use super::*;
    use crate::error::{BevError, BevResult};
    use image::{imageops::FilterType, DynamicImage, RgbaImage};
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    fn err(what: &'static str) -> impl FnOnce(windows::core::Error) -> BevError {
        move |e| BevError::Os(format!("{what}: {e}"))
    }

    /// target: "window" (the app in front, default), "window:<hwnd>" (that window),
    /// "screen" (the display the mouse is on) or "all".
    pub fn read(target: &str) -> BevResult<OcrResult> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let (img, ox, oy, source) = match target {
            "screen" => {
                let (i, x, y, l) = crate::screen::capture_raw("current")?;
                (i, x, y, l)
            }
            "all" => crate::screen::capture_raw("all")?,
            // One particular window, on whichever display it's on.
            t if t.starts_with("window:") => crate::screen::capture_raw(t)?,
            _ => {
                let w = win::user_window().ok_or_else(|| BevError::NotFound("there's no window to read".into()))?;
                let mut r = RECT::default();
                unsafe { GetWindowRect(HWND(w.hwnd as *mut _), &mut r) }.map_err(err("window position"))?;
                let (full, mx, my) = crate::screen::capture_at((r.left + r.right) / 2, (r.top + r.bottom) / 2)?;
                let (l, t) = ((r.left - mx).max(0) as u32, (r.top - my).max(0) as u32);
                let (rr, bb) = (((r.right - mx).max(0) as u32).min(full.width()), ((r.bottom - my).max(0) as u32).min(full.height()));
                if rr <= l + 4 || bb <= t + 4 {
                    return Err(BevError::Invalid("that window isn't on screen".into()));
                }
                let crop = image::imageops::crop_imm(&full, l, t, rr - l, bb - t).to_image();
                (crop, mx + l as i32, my + t as i32, format!("{} ({})", w.title, w.process))
            }
        };
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| BevError::NotFound("Windows has no text-recognition language installed (Settings → Time & language → Language).".into()))?;
        let max = OcrEngine::MaxImageDimension().unwrap_or(4096).max(1000);
        // Small text reads better a little larger; huge canvases must shrink.
        let mut scale = guard::fit_scale(img.width(), img.height(), max);
        if scale == 1.0 && img.width().max(img.height()) < 1400 {
            scale = (max as f64 / img.width().max(img.height()) as f64).min(2.0);
        }
        let img: RgbaImage = if (scale - 1.0).abs() > 1e-3 {
            let (w, h) = (((img.width() as f64) * scale).round().max(1.0) as u32, ((img.height() as f64) * scale).round().max(1.0) as u32);
            DynamicImage::ImageRgba8(img).resize_exact(w, h, FilterType::Triangle).to_rgba8()
        } else {
            img
        };
        let (w, h) = (img.width() as i32, img.height() as i32);
        let mut bgra = img.into_raw();
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let buf = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(err("OCR buffer"))?;
        let bmp = SoftwareBitmap::CreateCopyFromBuffer(&buf, BitmapPixelFormat::Bgra8, w, h).map_err(err("OCR bitmap"))?;
        let result = engine.RecognizeAsync(&bmp).map_err(err("OCR"))?.get().map_err(err("OCR"))?;
        let mut lines = Vec::new();
        for line in result.Lines().map_err(err("OCR lines"))? {
            let mut words = Vec::new();
            for word in line.Words().map_err(err("OCR words"))? {
                let r = word.BoundingRect().map_err(err("OCR word box"))?;
                words.push(OcrWord { text: word.Text().map(|t| t.to_string()).unwrap_or_default(), rect: to_desktop(r.X, r.Y, r.Width, r.Height, scale, ox, oy) });
            }
            let rect = union(&words.iter().map(|w| w.rect).collect::<Vec<_>>());
            lines.push(OcrLine { text: line.Text().map(|t| t.to_string()).unwrap_or_default(), rect, words });
        }
        Ok(OcrResult { source, lines })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use crate::error::{BevError, BevResult};
    pub fn read(_t: &str) -> BevResult<OcrResult> {
        Err(BevError::Invalid("text recognition is Windows-only".into()))
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_scaled_boxes_back() {
        assert_eq!(to_desktop(200.0, 100.0, 50.0, 20.0, 2.0, 1920, 0), [2020, 50, 25, 10]);
        assert_eq!(to_desktop(10.0, 10.0, 5.0, 5.0, 1.0, 0, 0), [10, 10, 5, 5]);
    }

    #[test]
    fn unions_boxes() {
        assert_eq!(union(&[[10, 10, 5, 5], [20, 8, 10, 4]]), [10, 8, 20, 7]);
        assert_eq!(union(&[]), [0, 0, 0, 0]);
    }
}
