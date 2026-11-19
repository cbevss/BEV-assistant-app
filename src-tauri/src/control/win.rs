//! Small Win32 window helpers shared by the control module.

#[derive(Debug, Clone, Default)]
pub struct WinInfo {
    pub hwnd: isize,
    pub title: String,
    pub class: String,
    /// Executable name, e.g. "notepad.exe".
    pub process: String,
    pub pid: u32,
}

/// Where a window is on the desktop.
#[derive(Debug, Clone, Default)]
pub struct WinRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub minimized: bool,
    pub title: String,
}

impl WinInfo {
    pub fn is_bev(&self) -> bool {
        self.pid == std::process::id()
    }
}

#[cfg(windows)]
mod imp {
    use super::WinInfo;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, GWL_EXSTYLE, GW_HWNDNEXT, WS_EX_TOOLWINDOW,
    };

    pub fn process_name(pid: u32) -> String {
        if pid == 0 {
            return String::new();
        }
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
            let mut buf = vec![0u16; 1024];
            let mut size = buf.len() as u32;
            let mut out = String::new();
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok() {
                let full = String::from_utf16_lossy(&buf[..size as usize]);
                out = full.rsplit(['\\', '/']).next().unwrap_or("").to_string();
            }
            let _ = CloseHandle(h);
            out
        }
    }

    pub fn info(hwnd: HWND) -> WinInfo {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            let title = if len > 0 {
                let mut buf = vec![0u16; (len + 1) as usize];
                let got = GetWindowTextW(hwnd, &mut buf);
                String::from_utf16_lossy(&buf[..got.max(0) as usize])
            } else {
                String::new()
            };
            let mut cls = [0u16; 128];
            let n = GetClassNameW(hwnd, &mut cls);
            let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            WinInfo { hwnd: hwnd.0 as isize, title, class, process: process_name(pid), pid }
        }
    }

    pub fn window_rect(hwnd: isize) -> Option<super::WinRect> {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindow};
        let h = HWND(hwnd as *mut _);
        unsafe {
            if !IsWindow(h).as_bool() {
                return None;
            }
            let mut r = RECT::default();
            GetWindowRect(h, &mut r).ok()?;
            Some(super::WinRect { left: r.left, top: r.top, right: r.right, bottom: r.bottom, minimized: IsIconic(h).as_bool(), title: info(h).title })
        }
    }

    pub fn foreground() -> Option<WinInfo> {
        let h = unsafe { GetForegroundWindow() };
        (!h.0.is_null()).then(|| info(h))
    }

    /// The window the user is working in: the foreground window, or if that's
    /// one of BEV's own, the next normal window below it.
    pub fn user_window() -> Option<WinInfo> {
        unsafe {
            let mut h = GetForegroundWindow();
            for _ in 0..200 {
                if h.0.is_null() {
                    return None;
                }
                let i = info(h);
                let tool = (GetWindowLongW(h, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0;
                if !i.is_bev() && IsWindowVisible(h).as_bool() && !IsIconic(h).as_bool() && !tool && !i.title.is_empty() {
                    return Some(i);
                }
                h = GetWindow(h, GW_HWNDNEXT).unwrap_or_default();
            }
            None
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::WinInfo;
    pub fn foreground() -> Option<WinInfo> {
        None
    }
    pub fn user_window() -> Option<WinInfo> {
        None
    }
    pub fn window_rect(_hwnd: isize) -> Option<super::WinRect> {
        None
    }
}

pub use imp::*;
