//! Minimal window management: enumerate top-level windows and focus one.

use crate::error::{BevError, BevResult};
use serde::Serialize;

#[derive(Serialize)]
pub struct WinInfo {
    pub hwnd: isize,
    pub title: String,
    /// Executable name, e.g. "Discord.exe".
    pub process: String,
    pub minimized: bool,
    /// Which display it's on, e.g. "display 2 of 2" (empty when minimised).
    pub display: String,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::Foundation::{BOOL, FALSE, HWND, LPARAM, RECT, TRUE};
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GWL_EXSTYLE, SW_RESTORE, WS_EX_TOOLWINDOW,
    };

    extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return TRUE;
            }
            let len = GetWindowTextLengthW(hwnd);
            if len == 0 {
                return TRUE;
            }
            let mut buf = vec![0u16; (len + 1) as usize];
            // Tool windows (floating palettes, tray helpers) aren't apps the user works in.
            if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
                return TRUE;
            }
            let got = GetWindowTextW(hwnd, &mut buf);
            if got > 0 {
                let title = String::from_utf16_lossy(&buf[..got as usize]);
                let info = crate::control::win::info(hwnd);
                if info.is_bev() {
                    return TRUE;
                }
                let minimized = IsIconic(hwnd).as_bool();
                let mut r = RECT::default();
                let centre = (!minimized && GetWindowRect(hwnd, &mut r).is_ok()).then(|| ((r.left + r.right) / 2, (r.top + r.bottom) / 2));
                let out = &mut *(lparam.0 as *mut Vec<(WinInfo, Option<(i32, i32)>)>);
                out.push((WinInfo { hwnd: hwnd.0 as isize, title, process: info.process, minimized, display: String::new() }, centre));
            }
            TRUE
        }
    }

    pub fn list() -> BevResult<Vec<WinInfo>> {
        let mut found: Vec<(WinInfo, Option<(i32, i32)>)> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(enum_cb), LPARAM(&mut found as *mut _ as isize));
        }
        Ok(found
            .into_iter()
            .map(|(mut w, centre)| {
                if let Some((x, y)) = centre {
                    w.display = crate::screen::display_label_at(x, y).unwrap_or_default();
                }
                w
            })
            .collect())
    }

    /// Bring a window to the front on whichever display it's on, restoring it if minimised.
    pub fn focus(hwnd: isize) -> BevResult<()> {
        unsafe {
            let h = HWND(hwnd as *mut _);
            if IsIconic(h).as_bool() {
                let _ = ShowWindow(h, SW_RESTORE);
            }
            if SetForegroundWindow(h).as_bool() {
                return Ok(());
            }
            // Windows only lets the foreground app hand over focus. Share its
            // input queue for a moment so the switch is allowed.
            let fg = GetForegroundWindow();
            let fg_thread = GetWindowThreadProcessId(fg, None);
            let me = GetCurrentThreadId();
            let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, TRUE).as_bool();
            let _ = BringWindowToTop(h);
            let ok = SetForegroundWindow(h).as_bool();
            if attached {
                let _ = AttachThreadInput(me, fg_thread, FALSE);
            }
            if ok || GetForegroundWindow() == h {
                Ok(())
            } else {
                Err(BevError::Os("Windows wouldn't bring that window to the front".into()))
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn list() -> BevResult<Vec<WinInfo>> {
        Err(BevError::Unsupported("window mgmt is Windows-only".into()))
    }
    pub fn focus(_h: isize) -> BevResult<()> {
        Err(BevError::Unsupported("window mgmt is Windows-only".into()))
    }
}

#[tauri::command]
pub fn list_windows() -> BevResult<Vec<WinInfo>> {
    imp::list()
}

#[tauri::command]
pub fn focus_window(hwnd: isize) -> BevResult<()> {
    imp::focus(hwnd)
}
