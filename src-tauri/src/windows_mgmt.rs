//! Window management: enumerate top-level windows, focus one, and read or set
//! where windows are (for snapping and saved layouts).

use crate::error::{BevError, BevResult};
use serde::{Deserialize, Serialize};

/// Where a window is, in screen pixels. state: "normal" | "maximized" | "minimized".
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Placement {
    pub hwnd: isize,
    pub process: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub state: String,
}

/// A monitor's usable area (without the taskbar), in screen pixels.
#[derive(Serialize, Clone, Debug)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub primary: bool,
}

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

    pub fn placements() -> BevResult<Vec<Placement>> {
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, IsZoomed, WINDOWPLACEMENT};
        let mut out = Vec::new();
        for w in list()? {
            unsafe {
                let h = HWND(w.hwnd as *mut _);
                let minimized = IsIconic(h).as_bool();
                let maximized = IsZoomed(h).as_bool();
                let mut r = RECT::default();
                if minimized {
                    // A minimised window's own rect is off-screen; use where it'll come back to.
                    let mut wp = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
                    if GetWindowPlacement(h, &mut wp).is_err() {
                        continue;
                    }
                    r = wp.rcNormalPosition;
                } else if GetWindowRect(h, &mut r).is_err() {
                    continue;
                }
                out.push(Placement {
                    hwnd: w.hwnd,
                    process: w.process,
                    title: w.title,
                    x: r.left,
                    y: r.top,
                    w: r.right - r.left,
                    h: r.bottom - r.top,
                    state: if minimized { "minimized" } else if maximized { "maximized" } else { "normal" }.into(),
                });
            }
        }
        Ok(out)
    }

    /// Move a window. Maximised: put it on the monitor at (x, y) then maximise there.
    pub fn place(hwnd: isize, x: i32, y: i32, w: i32, h: i32, state: &str) -> BevResult<()> {
        use windows::Win32::UI::WindowsAndMessaging::{IsWindow, IsZoomed, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE};
        unsafe {
            let hw = HWND(hwnd as *mut _);
            if !IsWindow(hw).as_bool() {
                return Err(BevError::NotFound("that window has closed".into()));
            }
            if w < 100 || h < 80 || w > 20000 || h > 20000 {
                return Err(BevError::Invalid("that size doesn't make sense".into()));
            }
            // A maximised or minimised window has to be restored before it can move.
            if IsIconic(hw).as_bool() || IsZoomed(hw).as_bool() {
                let _ = ShowWindow(hw, SW_RESTORE);
            }
            SetWindowPos(hw, HWND::default(), x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE).map_err(|e| BevError::Os(format!("Windows wouldn't move it: {e}")))?;
            match state {
                "maximized" => {
                    let _ = ShowWindow(hw, SW_MAXIMIZE);
                }
                "minimized" => {
                    let _ = ShowWindow(hw, SW_MINIMIZE);
                }
                _ => {}
            }
            Ok(())
        }
    }

    pub fn work_areas() -> Vec<WorkArea> {
        use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
        unsafe extern "system" fn cb(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
            let out = &mut *(data.0 as *mut Vec<WorkArea>);
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if GetMonitorInfoW(m, &mut mi).as_bool() {
                let r = mi.rcWork;
                out.push(WorkArea { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top, primary: mi.dwFlags & 1 != 0 });
            }
            TRUE
        }
        let mut out: Vec<WorkArea> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(HDC::default(), None, Some(cb), LPARAM(&mut out as *mut _ as isize));
        }
        out
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
    pub fn placements() -> BevResult<Vec<Placement>> {
        Err(BevError::Unsupported("window mgmt is Windows-only".into()))
    }
    pub fn place(_h: isize, _x: i32, _y: i32, _w: i32, _hh: i32, _s: &str) -> BevResult<()> {
        Err(BevError::Unsupported("window mgmt is Windows-only".into()))
    }
    pub fn work_areas() -> Vec<WorkArea> {
        vec![]
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

#[tauri::command]
pub fn window_placements() -> BevResult<Vec<Placement>> {
    imp::placements()
}

#[tauri::command]
pub fn place_window(hwnd: isize, x: i32, y: i32, w: i32, h: i32, state: Option<String>) -> BevResult<()> {
    imp::place(hwnd, x, y, w, h, state.as_deref().unwrap_or("normal"))
}

#[tauri::command]
pub fn monitor_work_areas() -> Vec<WorkArea> {
    imp::work_areas()
}

/// Seconds since the last keyboard or mouse input (any app), for "is the user here?".
#[tauri::command]
pub fn idle_seconds() -> u64 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut li).as_bool() {
            // Tick counts wrap every ~49 days; wrapping_sub handles it.
            return (GetTickCount().wrapping_sub(li.dwTime) / 1000) as u64;
        }
        0
    }
    #[cfg(not(windows))]
    0
}
