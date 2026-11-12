//! Minimal window management: enumerate top-level windows and focus one.

use crate::error::{BevError, BevResult};
use serde::Serialize;

#[derive(Serialize)]
pub struct WinInfo {
    pub hwnd: isize,
    pub title: String,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible, SetForegroundWindow,
        ShowWindow, SW_RESTORE,
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
            let got = GetWindowTextW(hwnd, &mut buf);
            if got > 0 {
                let title = String::from_utf16_lossy(&buf[..got as usize]);
                let out = &mut *(lparam.0 as *mut Vec<WinInfo>);
                out.push(WinInfo { hwnd: hwnd.0 as isize, title });
            }
            TRUE
        }
    }

    pub fn list() -> BevResult<Vec<WinInfo>> {
        let mut out: Vec<WinInfo> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(enum_cb), LPARAM(&mut out as *mut _ as isize));
        }
        Ok(out)
    }

    pub fn focus(hwnd: isize) -> BevResult<()> {
        unsafe {
            let h = HWND(hwnd as *mut _);
            let _ = ShowWindow(h, SW_RESTORE);
            if SetForegroundWindow(h).as_bool() {
                Ok(())
            } else {
                Err(BevError::Os("SetForegroundWindow refused".into()))
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
