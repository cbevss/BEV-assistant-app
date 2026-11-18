//! Screen replay: when the user turns it on, BEV keeps the last few seconds of
//! the display the mouse is on, so they can ask "look at the last 20 seconds".
//!
//! Privacy rules this module keeps:
//! - Off unless the user switches it on (Settings → Privacy); the app turns it
//!   off again in privacy mode.
//! - Frames live in RAM only, downscaled and JPEG-encoded, and are dropped as
//!   they age out. Nothing is written to disk.
//! - Nothing leaves the PC unless the user asks BEV to look back; then only the
//!   few frames picked for that question are handed to the app.
//! - BEV's overlay is excluded from capture (overlay.rs), as for screenshots.

use crate::error::{BevError, BevResult};
use base64::Engine;
use image::{DynamicImage, RgbaImage};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Two frames a second: enough to follow what happened, light on the CPU.
const PERIOD: Duration = Duration::from_millis(500);
/// Long edge of a stored frame.
const FRAME_EDGE: u32 = 1024;
const FRAME_QUALITY: u8 = 62;
pub const MIN_KEEP: u32 = 10;
pub const MAX_KEEP: u32 = 120;
const MAX_FRAMES_PER_CLIP: usize = 12;

struct Frame {
    at: Instant,
    jpeg: Vec<u8>,
    width: u32,
    height: u32,
    label: String,
}

struct Buffer {
    frames: VecDeque<Frame>,
    keep: Duration,
    enabled: bool,
}

static BUF: Mutex<Buffer> = Mutex::new(Buffer { frames: VecDeque::new(), keep: Duration::from_secs(30), enabled: false });
/// Bumped on every start/stop so an old capture thread knows to exit.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct ReplayStatus {
    pub enabled: bool,
    pub keep_secs: u32,
    /// How far back the buffer currently reaches.
    pub buffered_secs: f64,
}

#[derive(Serialize)]
pub struct ReplayFrame {
    /// Base64 JPEG.
    pub data: String,
    pub width: u32,
    pub height: u32,
    /// Seconds before the request this frame was taken.
    pub ago_secs: f64,
    pub label: String,
}

#[derive(Serialize)]
pub struct ReplayClip {
    pub frames: Vec<ReplayFrame>,
    /// The span the frames cover (may be shorter than asked if the buffer is young).
    pub covered_secs: f64,
    pub keep_secs: u32,
}

fn status_of(b: &Buffer) -> ReplayStatus {
    ReplayStatus {
        enabled: b.enabled,
        keep_secs: b.keep.as_secs() as u32,
        buffered_secs: b.frames.front().map(|f| f.at.elapsed().as_secs_f64()).unwrap_or(0.0),
    }
}

/// Turn replay on or off and set how many seconds to keep (10–120).
/// Turning it off clears everything that was kept.
#[tauri::command]
pub fn replay_configure(enabled: bool, keep_secs: Option<u32>) -> BevResult<ReplayStatus> {
    let mut b = BUF.lock().unwrap();
    if let Some(k) = keep_secs {
        b.keep = Duration::from_secs(k.clamp(MIN_KEEP, MAX_KEEP) as u64);
    }
    let was = b.enabled;
    b.enabled = enabled;
    if !enabled {
        b.frames.clear();
        b.frames.shrink_to_fit();
        GENERATION.fetch_add(1, Ordering::SeqCst);
    } else if !was {
        let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::Builder::new()
            .name("bev-replay".into())
            .spawn(move || capture_loop(gen))
            .map_err(|e| BevError::Os(format!("replay thread: {e}")))?;
    }
    Ok(status_of(&b))
}

#[tauri::command]
pub fn replay_status() -> ReplayStatus {
    status_of(&BUF.lock().unwrap())
}

fn capture_loop(gen: u64) {
    log::info!("screen replay on");
    while GENERATION.load(Ordering::SeqCst) == gen {
        let t0 = Instant::now();
        match grab() {
            Ok(f) => {
                let mut b = BUF.lock().unwrap();
                if GENERATION.load(Ordering::SeqCst) != gen {
                    break; // turned off while we were capturing: don't keep it
                }
                b.frames.push_back(f);
                let keep = b.keep;
                while b.frames.front().is_some_and(|f| f.at.elapsed() > keep) {
                    b.frames.pop_front();
                }
            }
            // The secure desktop (UAC, lock screen) can't be captured; just skip.
            Err(e) => log::debug!("replay frame skipped: {e}"),
        }
        let spent = t0.elapsed();
        std::thread::sleep(PERIOD.saturating_sub(spent).max(Duration::from_millis(50)));
    }
    log::info!("screen replay off");
}

fn grab() -> BevResult<Frame> {
    let at = Instant::now();
    let (img, _, _, label) = crate::screen::capture_raw("current")?;
    let (jpeg, width, height) = shrink(img)?;
    Ok(Frame { at, jpeg, width, height, label })
}

fn shrink(img: RgbaImage) -> BevResult<(Vec<u8>, u32, u32)> {
    let (w, h) = fit_edge(img.width(), img.height(), FRAME_EDGE);
    let small = image::imageops::thumbnail(&img, w, h);
    let rgb = DynamicImage::ImageRgba8(small).to_rgb8();
    let mut buf = Vec::with_capacity(96 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, FRAME_QUALITY)
        .encode_image(&rgb)
        .map_err(|e| BevError::Os(format!("encode: {e}")))?;
    Ok((buf, w, h))
}

pub(crate) fn fit_edge(w: u32, h: u32, edge: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= edge || long == 0 {
        return (w.max(1), h.max(1));
    }
    let s = edge as f64 / long as f64;
    (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1))
}

/// How many frames to show the AI for a span: about one every two seconds,
/// at least 3, at most 12 (vision costs grow with every image).
pub(crate) fn frames_for(seconds: f64, max: Option<u32>) -> usize {
    let auto = (seconds / 2.0).ceil() as usize;
    let cap = max.map(|m| m as usize).unwrap_or(MAX_FRAMES_PER_CLIP).clamp(1, MAX_FRAMES_PER_CLIP);
    auto.clamp(3, MAX_FRAMES_PER_CLIP).min(cap)
}

/// Evenly spaced picks from n items, always including the first and last.
pub(crate) fn pick(n: usize, want: usize) -> Vec<usize> {
    if n == 0 || want == 0 {
        return vec![];
    }
    if want >= n {
        return (0..n).collect();
    }
    if want == 1 {
        return vec![n - 1];
    }
    let mut out: Vec<usize> = (0..want).map(|i| ((i as f64) * (n - 1) as f64 / (want - 1) as f64).round() as usize).collect();
    out.dedup();
    out
}

/// The last `seconds` of the screen as a handful of frames, oldest first.
#[tauri::command]
pub fn replay_clip(seconds: f64, max_frames: Option<u32>) -> BevResult<ReplayClip> {
    let b = BUF.lock().unwrap();
    if !b.enabled {
        return Err(BevError::Message("Screen replay is off. Turn it on in Settings → Privacy so BEV keeps the last few seconds of your screen.".into()));
    }
    let keep = b.keep.as_secs() as u32;
    let span = if seconds.is_finite() && seconds > 0.0 { seconds.min(keep as f64) } else { 10.0_f64.min(keep as f64) };
    let now = Instant::now();
    let recent: Vec<&Frame> = b.frames.iter().filter(|f| now.duration_since(f.at).as_secs_f64() <= span + 0.25).collect();
    if recent.is_empty() {
        return Err(BevError::Message("Screen replay has only just started, so there's nothing to look back at yet.".into()));
    }
    let idx = pick(recent.len(), frames_for(span, max_frames));
    let frames: Vec<ReplayFrame> = idx
        .into_iter()
        .map(|i| {
            let f = recent[i];
            ReplayFrame {
                data: base64::engine::general_purpose::STANDARD.encode(&f.jpeg),
                width: f.width,
                height: f.height,
                ago_secs: (now.duration_since(f.at).as_secs_f64() * 10.0).round() / 10.0,
                label: f.label.clone(),
            }
        })
        .collect();
    let covered = now.duration_since(recent[0].at).as_secs_f64();
    Ok(ReplayClip { frames, covered_secs: (covered * 10.0).round() / 10.0, keep_secs: keep })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_are_even_and_keep_both_ends() {
        assert_eq!(pick(20, 5), vec![0, 5, 10, 14, 19]);
        assert_eq!(pick(3, 8), vec![0, 1, 2]);
        assert_eq!(pick(10, 1), vec![9]);
        assert!(pick(0, 4).is_empty());
        let p = pick(240, 12);
        assert_eq!((p[0], *p.last().unwrap(), p.len()), (0, 239, 12));
    }

    #[test]
    fn frame_counts_scale_with_the_span() {
        assert_eq!(frames_for(4.0, None), 3);
        assert_eq!(frames_for(10.0, None), 5);
        assert_eq!(frames_for(60.0, None), 12);
        assert_eq!(frames_for(60.0, Some(6)), 6);
        assert_eq!(frames_for(60.0, Some(99)), 12);
    }

    #[test]
    fn frames_are_downscaled() {
        assert_eq!(fit_edge(3840, 2160, 1024), (1024, 576));
        assert_eq!(fit_edge(800, 600, 1024), (800, 600));
        let (jpeg, w, h) = shrink(RgbaImage::new(2560, 1440)).unwrap();
        assert_eq!((w, h), (1024, 576));
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
    }
}
