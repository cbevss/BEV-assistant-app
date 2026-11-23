//! "Watch me": while the user records a demonstration, note their clicks
//! (and what they clicked, by app/name/role) and key presses, so the app can
//! turn them into a routine BEV repeats.
//!
//! Privacy and safety:
//! - Only runs between record_start and record_stop (or 5 minutes), started
//!   by the user; the app shows that it's recording.
//! - Events stay in memory and go only to the app's own review screen.
//! - Clicks on BEV's own windows and input BEV itself sends are ignored.
//! - Typing into password boxes is dropped (the app also drops it).

use serde::Serialize;
use std::sync::Mutex;

#[derive(Debug, Serialize)]
pub struct ClickTarget {
    pub name: String,
    pub role: &'static str,
    pub process: String,
    pub password: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecEvent {
    Click { t: u64, x: i32, y: i32, button: &'static str, target: Option<ClickTarget> },
    Key { t: u64, vk: u32, ctrl: bool, alt: bool, shift: bool, win: bool },
}

impl RecEvent {
    fn t(&self) -> u64 {
        match self {
            RecEvent::Click { t, .. } | RecEvent::Key { t, .. } => *t,
        }
    }
}

static EVENTS: Mutex<Vec<RecEvent>> = Mutex::new(Vec::new());

/// Upper bound per recording, so a forgotten recording can't grow forever.
const MAX_EVENTS: usize = 5000;
const MAX_SECS: u64 = 300;

fn push(e: RecEvent) {
    let mut v = EVENTS.lock().unwrap();
    if v.len() < MAX_EVENTS {
        v.push(e);
    }
}

#[derive(Serialize)]
pub struct RecordStatus {
    pub recording: bool,
    pub events: usize,
}

#[tauri::command]
pub fn record_start() -> Result<(), String> {
    EVENTS.lock().unwrap().clear();
    imp::start(MAX_SECS)
}

/// Stop recording and hand back what was recorded, oldest first.
#[tauri::command]
pub fn record_stop() -> Vec<RecEvent> {
    imp::stop();
    let mut v = std::mem::take(&mut *EVENTS.lock().unwrap());
    v.sort_by_key(|e| e.t());
    v
}

#[tauri::command]
pub fn record_status() -> RecordStatus {
    RecordStatus { recording: imp::running(), events: EVENTS.lock().unwrap().len() }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::time::{Duration, Instant};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN,
    };

    static RUNNING: AtomicBool = AtomicBool::new(false);
    static THREAD: AtomicU32 = AtomicU32::new(0);
    static CLICKS: Mutex<Option<Sender<(u64, i32, i32, &'static str)>>> = Mutex::new(None);
    static STARTED: Mutex<Option<Instant>> = Mutex::new(None);

    /// Input BEV sends itself (SendInput) is marked injected: not the user's.
    const LLMHF_INJECTED: u32 = 0x1;
    const LLKHF_INJECTED: u32 = 0x10;

    fn ms() -> u64 {
        STARTED.lock().unwrap().map(|s| s.elapsed().as_millis() as u64).unwrap_or(0)
    }

    fn down(vk: i32) -> bool {
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN {
                let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                if info.flags & LLMHF_INJECTED == 0 {
                    let button = if msg == WM_LBUTTONDOWN { "left" } else { "right" };
                    // Resolving what was clicked is slow: hand it to the worker.
                    if let Some(tx) = CLICKS.lock().unwrap().as_ref() {
                        let _ = tx.send((ms(), info.pt.x, info.pt.y, button));
                    }
                }
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    unsafe extern "system" fn key_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = wparam.0 as u32;
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                if info.flags.0 & LLKHF_INJECTED == 0 {
                    push(RecEvent::Key {
                        t: ms(),
                        vk: info.vkCode,
                        ctrl: down(VK_CONTROL.0 as i32),
                        alt: down(VK_MENU.0 as i32),
                        shift: down(VK_SHIFT.0 as i32),
                        win: down(VK_LWIN.0 as i32) || down(VK_RWIN.0 as i32),
                    });
                }
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    pub fn running() -> bool {
        RUNNING.load(Ordering::SeqCst)
    }

    pub fn start(max_secs: u64) -> Result<(), String> {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return Err("already recording".into());
        }
        *STARTED.lock().unwrap() = Some(Instant::now());
        let me = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_default();

        // Worker: work out what each click landed on.
        let (tx, rx) = channel::<(u64, i32, i32, &'static str)>();
        *CLICKS.lock().unwrap() = Some(tx);
        std::thread::Builder::new()
            .name("bev-record-clicks".into())
            .spawn(move || {
                for (t, x, y, button) in rx {
                    let target = super::super::uia::element_at(x, y).ok().flatten();
                    if target.as_ref().is_some_and(|p| p.process.eq_ignore_ascii_case(&me)) {
                        continue; // clicks on BEV itself (e.g. its Stop button)
                    }
                    push(RecEvent::Click {
                        t,
                        x,
                        y,
                        button,
                        target: target.map(|p| ClickTarget { name: p.name, role: p.role, process: p.process, password: p.password }),
                    });
                }
            })
            .map_err(|e| e.to_string())?;

        // Hook thread: low-level hooks need a message loop on their own thread.
        let (ready_tx, ready_rx) = channel::<Result<(), String>>();
        std::thread::Builder::new()
            .name("bev-record-hooks".into())
            .spawn(move || unsafe {
                THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
                let module = GetModuleHandleW(PCWSTR::null()).map(|m| HINSTANCE(m.0)).unwrap_or_default();
                let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
                let keys = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_proc), module, 0);
                match (mouse, keys) {
                    (Ok(m), Ok(k)) => {
                        let _ = ready_tx.send(Ok(()));
                        let mut msg = MSG::default();
                        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {}
                        let _ = UnhookWindowsHookEx(m);
                        let _ = UnhookWindowsHookEx(k);
                    }
                    (m, k) => {
                        if let Ok(m) = m {
                            let _ = UnhookWindowsHookEx(m);
                        }
                        if let Ok(k) = k {
                            let _ = UnhookWindowsHookEx(k);
                        }
                        let _ = ready_tx.send(Err("couldn't start recording (input hooks refused)".into()));
                    }
                }
                *CLICKS.lock().unwrap() = None; // ends the click worker
                RUNNING.store(false, Ordering::SeqCst);
            })
            .map_err(|e| e.to_string())?;

        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                stop();
                return Err("couldn't start recording".into());
            }
        }

        // Stop on its own after a while, in case it's forgotten.
        let started = *STARTED.lock().unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(max_secs));
            if running() && *STARTED.lock().unwrap() == started {
                stop();
            }
        });
        Ok(())
    }

    pub fn stop() {
        let t = THREAD.swap(0, Ordering::SeqCst);
        if t != 0 {
            unsafe {
                let _ = PostThreadMessageW(t, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        // Let the click worker finish resolving the last click.
        for _ in 0..20 {
            if !running() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

/// Linux keycode → Windows VK (the recording format), via the input map.
pub fn evdev_to_vk(code: u16) -> Option<u32> {
    (0u16..=0xFF).find(|&vk| super::input::vk_to_evdev(vk) == Some(code as i32)).map(u32::from)
}

/// One `struct input_event` (64-bit): timeval (16 bytes), type, code, value.
pub fn parse_event(b: &[u8; 24]) -> (u16, u16, i32) {
    (u16::from_ne_bytes([b[16], b[17]]), u16::from_ne_bytes([b[18], b[19]]), i32::from_ne_bytes([b[20], b[21], b[22], b[23]]))
}

/// Linux (Wayland): apps can't watch global input, so BEV reads the kernel's
/// input devices, which needs the user in the `input` group. Click positions
/// come from KWin. Input BEV sends goes through the compositor, not these
/// devices, so it's never recorded.
#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::io::Read;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    static RUNNING: AtomicBool = AtomicBool::new(false);
    /// Bumped on every start so old reader threads retire.
    static GEN: AtomicU64 = AtomicU64::new(0);
    static STARTED: Mutex<Option<Instant>> = Mutex::new(None);
    static MODS: Mutex<[bool; 4]> = Mutex::new([false; 4]); // ctrl, alt, shift, super

    const EV_KEY: u16 = 1;
    const BTN_LEFT: u16 = 0x110;
    const BTN_RIGHT: u16 = 0x111;

    fn ms() -> u64 {
        STARTED.lock().unwrap().map(|s| s.elapsed().as_millis() as u64).unwrap_or(0)
    }

    fn on_click(t: u64, button: &'static str) {
        // Let the click land (and focus its window) before asking KWin.
        std::thread::sleep(Duration::from_millis(80));
        let Ok(v) = crate::kwin::script("var p=workspace.cursorPos;var w=workspace.activeWindow;return {x:Math.round(p.x),y:Math.round(p.y),pid:w?w.pid:0,title:w?String(w.caption):''};") else { return };
        let num = |k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
        let (x, y, pid) = (num("x") as i32, num("y") as i32, num("pid") as u32);
        if pid == std::process::id() {
            return; // clicks on BEV itself
        }
        let target = super::super::uia::element_at(x, y).ok().flatten().map(|p| ClickTarget { name: p.name, role: p.role, process: p.process, password: p.password }).or_else(|| {
            let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
            (!title.is_empty()).then(|| ClickTarget { name: title, role: "window", process: crate::kwin::process_name(pid).unwrap_or_default(), password: false })
        });
        push(RecEvent::Click { t, x, y, button, target });
    }

    fn on_key(code: u16, value: i32) {
        let idx = match code {
            29 | 97 => Some(0),
            56 | 100 => Some(1),
            42 | 54 => Some(2),
            125 | 126 => Some(3),
            _ => None,
        };
        if let Some(i) = idx {
            MODS.lock().unwrap()[i] = value != 0;
        }
        if value != 1 {
            return; // only presses, not releases or auto-repeat
        }
        let Some(vk) = evdev_to_vk(code) else { return };
        let m = *MODS.lock().unwrap();
        push(RecEvent::Key { t: ms(), vk, ctrl: m[0], alt: m[1], shift: m[2], win: m[3] });
    }

    fn reader(mut f: std::fs::File, gen: u64) {
        let mut buf = [0u8; 24];
        while f.read_exact(&mut buf).is_ok() {
            if GEN.load(Ordering::SeqCst) != gen || !RUNNING.load(Ordering::SeqCst) {
                return;
            }
            let (ty, code, value) = parse_event(&buf);
            if ty != EV_KEY {
                continue;
            }
            match code {
                BTN_LEFT | BTN_RIGHT if value == 1 => {
                    let t = ms();
                    let b = if code == BTN_LEFT { "left" } else { "right" };
                    std::thread::spawn(move || on_click(t, b));
                }
                c if c < 0x100 => on_key(c, value),
                _ => {}
            }
        }
    }

    pub fn running() -> bool {
        RUNNING.load(Ordering::SeqCst)
    }

    pub fn start(max_secs: u64) -> Result<(), String> {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return Err("already recording".into());
        }
        let mut files = Vec::new();
        let mut denied = false;
        for e in std::fs::read_dir("/dev/input").map_err(|e| e.to_string())?.flatten() {
            let p = e.path();
            if !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("event")) {
                continue;
            }
            match std::fs::File::open(&p) {
                Ok(f) => files.push(f),
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => denied = true,
                Err(_) => {}
            }
        }
        if files.is_empty() {
            RUNNING.store(false, Ordering::SeqCst);
            return Err(if denied {
                "On Wayland, BEV can only watch your clicks and keys if your account can read input devices. To allow it, run: sudo usermod -aG input $USER, then sign out and back in. Note this lets any app you run read your keyboard, so only do it if you're happy with that.".into()
            } else {
                "no input devices found".into()
            });
        }
        *STARTED.lock().unwrap() = Some(Instant::now());
        *MODS.lock().unwrap() = [false; 4];
        let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
        for f in files {
            std::thread::spawn(move || reader(f, gen));
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(max_secs));
            if GEN.load(Ordering::SeqCst) == gen {
                RUNNING.store(false, Ordering::SeqCst);
            }
        });
        Ok(())
    }

    pub fn stop() {
        RUNNING.store(false, Ordering::SeqCst);
        GEN.fetch_add(1, Ordering::SeqCst);
        // Let in-flight clicks finish resolving.
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    pub fn running() -> bool {
        false
    }
    pub fn start(_max: u64) -> Result<(), String> {
        Err("recording isn't supported on this OS".into())
    }
    pub fn stop() {}
}

#[cfg(test)]
mod linux_tests {
    #[test]
    fn maps_keys_back_and_parses_events() {
        assert_eq!(super::evdev_to_vk(30), Some(0x41)); // A
        assert_eq!(super::evdev_to_vk(28), Some(0x0D)); // enter
        assert_eq!(super::evdev_to_vk(0xFFF), None);
        let mut b = [0u8; 24];
        b[16..18].copy_from_slice(&1u16.to_ne_bytes());
        b[18..20].copy_from_slice(&0x110u16.to_ne_bytes());
        b[20..24].copy_from_slice(&1i32.to_ne_bytes());
        assert_eq!(super::parse_event(&b), (1, 0x110, 1));
    }
}
