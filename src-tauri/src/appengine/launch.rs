//! Launch and close apps, and verify what actually happened.
//!
//! "The launch call succeeded" isn't evidence an app opened, so after
//! launching BEV watches for a new top-level window belonging to the app
//! (by process id, process image name, or for Store apps hosted in
//! ApplicationFrameHost, the window title) and reports exactly what it saw.

use super::model::{AppKind, AppRecord};
use super::resolve::normalise;
use serde::Serialize;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LaunchOutcome {
    /// A new window appeared.
    Opened { window: String, pid: Option<u32> },
    /// It was already open; brought to the front (or flashing if Windows refused).
    AlreadyRunning { window: String, focused: bool },
    /// The process is running but no window has appeared yet (slow start, tray app).
    Starting { detail: String },
    /// Windows accepted the request but BEV couldn't confirm anything opened.
    Unverified { detail: String },
    Failed { error: String },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CloseOutcome {
    Closed { windows: usize },
    NotRunning,
    /// Asked to close but a window is still open (often an unsaved-changes prompt).
    StillOpen { window: String },
    ForceClosed { processes: usize },
    Failed { error: String },
}

/// Words from the app's name worth looking for in a window title.
pub fn title_words(name: &str) -> Vec<String> {
    const SKIP: &[&str] = &["microsoft", "google", "windows", "studio", "app", "the", "for", "and", "64bit", "x64", "desktop"];
    normalise(name)
        .split(' ')
        .filter(|w| w.len() >= 4 && !SKIP.contains(w) && !w.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_string)
        .collect()
}

pub fn title_matches(title: &str, words: &[String]) -> bool {
    if words.is_empty() {
        return false;
    }
    let t = format!(" {} ", normalise(title));
    words.iter().any(|w| t.contains(&format!(" {w} ")))
}

/// Does a window (with this process image) belong to the app?
pub fn window_belongs(a: &AppRecord, image: Option<&str>, title: &str) -> bool {
    let img = image.and_then(|p| p.rsplit(['\\', '/']).next()).unwrap_or("").to_lowercase();
    if let Some(exe) = &a.exe_name {
        if !img.is_empty() && img == exe.to_lowercase() {
            return true;
        }
    }
    // Packaged apps often show their window through ApplicationFrameHost.exe;
    // built-in settings pages too.
    let hosted = img == "applicationframehost.exe" || img == "systemsettings.exe";
    hosted && (a.kind == AppKind::Packaged || a.kind == AppKind::System) && title_matches(title, &title_words(&a.name))
}

#[cfg(windows)]
mod imp {
    use super::super::launchplan::{multi_instance, plan, LaunchPlan};
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::time::{Duration, Instant};
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM, TRUE, WPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessId, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_MENU};
    use windows::Win32::UI::Shell::{
        ApplicationActivationManager, IApplicationActivationManager, ShellExecuteExW, AO_NONE, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC,
        SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
        PostMessageW, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE, SW_SHOWNORMAL, WM_CLOSE,
    };

    const STILL_ACTIVE: u32 = 259;

    /// COM for this thread (ShellExecuteEx and activation want an STA).
    struct Com(bool);
    impl Com {
        fn init() -> Com {
            Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok())
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    #[derive(Clone)]
    struct Win {
        hwnd: isize,
        pid: u32,
        title: String,
    }

    unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }
        // Top-level app windows only, not tool windows owned by another.
        if GetWindow(hwnd, GW_OWNER).map(|o| !o.0.is_null()).unwrap_or(false) {
            return TRUE;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return TRUE;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
        let out = &mut *(lp.0 as *mut Vec<Win>);
        out.push(Win { hwnd: hwnd.0 as isize, pid, title: String::from_utf16_lossy(&buf[..n.max(0) as usize]) });
        TRUE
    }

    fn windows() -> Vec<Win> {
        let mut v: Vec<Win> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect), LPARAM(&mut v as *mut _ as isize));
        }
        v
    }

    fn image(pid: u32, cache: &mut HashMap<u32, Option<String>>) -> Option<String> {
        cache
            .entry(pid)
            .or_insert_with(|| unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
                let _ = CloseHandle(h);
                ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
            })
            .clone()
    }

    fn hwnd(h: isize) -> HWND {
        HWND(h as *mut _)
    }

    /// Windows only lets the foreground app hand focus to another window; a
    /// synthetic Alt tap makes BEV eligible when the user is talking to it.
    fn bring_to_front(h: isize) -> bool {
        unsafe {
            let w = hwnd(h);
            if IsIconic(w).as_bool() {
                let _ = ShowWindow(w, SW_RESTORE);
            }
            if SetForegroundWindow(w).as_bool() {
                return true;
            }
            let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_MENU, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
            };
            let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            SetForegroundWindow(w).as_bool()
        }
    }

    fn shell(file: &str, params: Option<&str>, dir: Option<&str>) -> Result<Option<HANDLE>, String> {
        let file_w = HSTRING::from(file);
        let params_w = params.map(HSTRING::from);
        let dir_w = dir.map(HSTRING::from);
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
            lpFile: PCWSTR(file_w.as_ptr()),
            lpParameters: params_w.as_ref().map(|p| PCWSTR(p.as_ptr())).unwrap_or(PCWSTR::null()),
            lpDirectory: dir_w.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut info) }.map_err(|e| format!("Windows couldn't start it: {}", e.message()))?;
        Ok((!info.hProcess.is_invalid()).then_some(info.hProcess))
    }

    fn activate(aumid: &str) -> Result<u32, String> {
        unsafe {
            let m: IApplicationActivationManager = CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)
                .map_err(|e| format!("activation manager unavailable: {}", e.message()))?;
            m.ActivateApplication(&HSTRING::from(aumid), PCWSTR::null(), AO_NONE)
                .map_err(|e| format!("Windows couldn't activate the app: {}", e.message()))
        }
    }

    fn exit_code(h: HANDLE) -> Option<u32> {
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(h, &mut code) }.ok()?;
        (code != STILL_ACTIVE).then_some(code)
    }

    fn pid_alive(pid: u32) -> bool {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
            let alive = exit_code(h).is_none();
            let _ = CloseHandle(h);
            alive
        }
    }

    pub fn launch(a: &AppRecord, timeout: Duration) -> LaunchOutcome {
        let _com = Com::init();
        let mut cache = HashMap::new();
        let before = windows();

        if !multi_instance(a) {
            if let Some(w) = before.iter().find(|w| window_belongs(a, image(w.pid, &mut cache).as_deref(), &w.title)) {
                let focused = bring_to_front(w.hwnd);
                return LaunchOutcome::AlreadyRunning { window: w.title.clone(), focused };
            }
        }

        let plan = match plan(a) {
            Ok(p) => p,
            Err(e) => return LaunchOutcome::Failed { error: e },
        };
        let (pid, handle) = match &plan {
            LaunchPlan::Activate { aumid } => match activate(aumid) {
                Ok(pid) => (Some(pid), None),
                Err(e) => return LaunchOutcome::Failed { error: e },
            },
            LaunchPlan::Shell { file, dir } => match shell(file, None, dir.as_deref()) {
                Ok(Some(h)) => (Some(unsafe { GetProcessId(h) }).filter(|p| *p != 0), Some(h)),
                Ok(None) => (None, None),
                Err(e) => return LaunchOutcome::Failed { error: e },
            },
            LaunchPlan::AppsFolder { app_id } => match shell("explorer.exe", Some(&format!("shell:AppsFolder\\{app_id}")), None) {
                Ok(h) => {
                    if let Some(h) = h {
                        unsafe {
                            let _ = CloseHandle(h);
                        }
                    }
                    (None, None)
                }
                Err(e) => return LaunchOutcome::Failed { error: e },
            },
        };

        let seen: HashSet<isize> = before.iter().map(|w| w.hwnd).collect();
        let words = title_words(&a.name);
        let deadline = Instant::now() + timeout;
        let mut early_exit: Option<u32> = None;
        let outcome = 'watch: loop {
            std::thread::sleep(Duration::from_millis(250));
            for w in windows().into_iter().filter(|w| !seen.contains(&w.hwnd)) {
                let img = image(w.pid, &mut cache);
                if Some(w.pid) == pid || window_belongs(a, img.as_deref(), &w.title) || title_matches(&w.title, &words) {
                    break 'watch LaunchOutcome::Opened { window: w.title, pid: Some(w.pid) };
                }
            }
            if let (Some(h), None) = (handle, early_exit) {
                early_exit = exit_code(h);
            }
            if Instant::now() >= deadline {
                break if pid.is_some_and(pid_alive) {
                    LaunchOutcome::Starting { detail: "it's running but no window has appeared yet".into() }
                } else if let Some(code) = early_exit.filter(|c| *c != 0) {
                    LaunchOutcome::Failed { error: format!("it exited straight away (exit code {code})") }
                } else if matches!(plan, LaunchPlan::Shell { .. }) && handle.is_some() && early_exit == Some(0) {
                    // Launchers (Update.exe, Steam stubs) hand off and exit.
                    LaunchOutcome::Unverified { detail: "the launcher ran but no window appeared yet".into() }
                } else {
                    LaunchOutcome::Unverified { detail: "Windows accepted the request, but no window appeared".into() }
                };
            }
        };
        if let Some(h) = handle {
            unsafe {
                let _ = CloseHandle(h);
            }
        }
        outcome
    }

    pub fn close(a: &AppRecord, force: bool, pids: &[u32]) -> CloseOutcome {
        let mut cache = HashMap::new();
        let targets: Vec<Win> = windows()
            .into_iter()
            .filter(|w| pids.contains(&w.pid) || window_belongs(a, image(w.pid, &mut cache).as_deref(), &w.title))
            .collect();

        if force {
            let mut all: HashSet<u32> = pids.iter().copied().collect();
            all.extend(targets.iter().filter(|w| image(w.pid, &mut cache).is_some_and(|i| !i.to_lowercase().ends_with("applicationframehost.exe"))).map(|w| w.pid));
            if all.is_empty() {
                return CloseOutcome::NotRunning;
            }
            let mut n = 0;
            for pid in all {
                unsafe {
                    if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                        if TerminateProcess(h, 1).is_ok() {
                            n += 1;
                        }
                        let _ = CloseHandle(h);
                    }
                }
            }
            return if n > 0 { CloseOutcome::ForceClosed { processes: n } } else { CloseOutcome::Failed { error: "Windows refused to end it (it may need admin rights)".into() } };
        }

        if targets.is_empty() {
            return if pids.is_empty() { CloseOutcome::NotRunning } else { CloseOutcome::StillOpen { window: "(running in the background with no window)".into() } };
        }
        for w in &targets {
            unsafe {
                let _ = PostMessageW(hwnd(w.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let open: Vec<&Win> = targets.iter().filter(|w| unsafe { IsWindow(hwnd(w.hwnd)).as_bool() && IsWindowVisible(hwnd(w.hwnd)).as_bool() }).collect();
            if open.is_empty() {
                return CloseOutcome::Closed { windows: targets.len() };
            }
            if Instant::now() >= deadline {
                return CloseOutcome::StillOpen { window: open[0].title.clone() };
            }
        }
    }

}

#[cfg(windows)]
pub use imp::{close, launch};

#[cfg(target_os = "linux")]
pub use linux_imp::{close, launch};

/// Linux: start apps from their .desktop entry and verify by process.
/// (Window-level checks arrive with the Wayland window support.)
#[cfg(target_os = "linux")]
mod linux_imp {
    use super::*;
    use std::time::{Duration, Instant};
    use sysinfo::{ProcessesToUpdate, Signal, System};

    fn procs(sys: &mut System, a: &AppRecord) -> Vec<u32> {
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let Some(want) = a.exe_name.as_deref().map(str::to_lowercase) else { return Vec::new() };
        let me = std::process::id();
        sys.processes()
            .iter()
            .filter(|(pid, p)| {
                pid.as_u32() != me && {
                    let n = p.name().to_string_lossy().to_lowercase();
                    // Linux truncates comm to 15 chars.
                    n == want || (n.len() == 15 && want.starts_with(&n))
                        || p.exe().and_then(|e| e.file_name()).is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(&want))
                }
            })
            .map(|(pid, _)| pid.as_u32())
            .collect()
    }

    fn start(a: &AppRecord) -> Result<(), String> {
        if let Some(file) = a.shortcut.as_deref().filter(|f| f.ends_with(".desktop")) {
            // gio honours the entry fully (Flatpak, env, working dir, terminal apps).
            if crate::linux::run("gio", &["launch", file]).is_ok() {
                return Ok(());
            }
            if let Some(id) = a.app_id.as_deref() {
                let id = id.trim_end_matches(".desktop");
                if crate::linux::spawn("kstart", &["--application", id]).is_ok() {
                    return Ok(());
                }
            }
            let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
            let entry = super::super::desktop::parse_entry(&text);
            let argv = super::super::desktop::exec_argv(entry.get("Exec").map(String::as_str).unwrap_or(""));
            let (prog, args) = argv.split_first().ok_or("the app's entry has no command")?;
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            return crate::linux::spawn(prog, &args).map_err(|e| e.to_string());
        }
        let exe = a.exe_path.as_deref().ok_or("BEV doesn't know how to start this app")?;
        crate::linux::spawn(exe, &[]).map_err(|e| e.to_string())
    }

    pub fn launch(a: &AppRecord, timeout: Duration) -> LaunchOutcome {
        let mut sys = System::new();
        let before = procs(&mut sys, a);
        if let Err(e) = start(a) {
            return LaunchOutcome::Failed { error: format!("couldn't start {}: {e}", a.name) };
        }
        if !before.is_empty() {
            // Most Linux apps are single-instance: a second launch raises the window.
            return LaunchOutcome::AlreadyRunning { window: a.name.clone(), focused: true };
        }
        if a.exe_name.is_none() {
            return LaunchOutcome::Unverified { detail: format!("asked KDE to open {}", a.name) };
        }
        let deadline = Instant::now() + timeout;
        loop {
            let now = procs(&mut sys, a);
            if let Some(pid) = now.first() {
                return LaunchOutcome::Opened { window: a.name.clone(), pid: Some(*pid) };
            }
            if Instant::now() >= deadline {
                return LaunchOutcome::Unverified {
                    detail: format!("asked KDE to open {}, but no {} process appeared yet", a.name, a.exe_name.as_deref().unwrap_or("app")),
                };
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    pub fn close(a: &AppRecord, force: bool, pids: &[u32]) -> CloseOutcome {
        let mut sys = System::new();
        let mut targets = procs(&mut sys, a);
        for p in pids {
            if !targets.contains(p) {
                targets.push(*p);
            }
        }
        if targets.is_empty() {
            return CloseOutcome::NotRunning;
        }
        let signal = if force { Signal::Kill } else { Signal::Term };
        let mut sent = 0;
        for pid in &targets {
            if let Some(p) = sys.process(sysinfo::Pid::from_u32(*pid)) {
                if p.kill_with(signal).unwrap_or(false) {
                    sent += 1;
                }
            }
        }
        if sent == 0 {
            return CloseOutcome::Failed { error: format!("couldn't signal {}", a.name) };
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let left = procs(&mut sys, a);
            if left.is_empty() {
                return if force { CloseOutcome::ForceClosed { processes: sent } } else { CloseOutcome::Closed { windows: sent } };
            }
            if Instant::now() >= deadline {
                return CloseOutcome::StillOpen { window: a.name.clone() };
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn launch(_a: &AppRecord, _t: std::time::Duration) -> LaunchOutcome {
    LaunchOutcome::Failed { error: "launching apps isn't supported on this OS".into() }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn close(_a: &AppRecord, _force: bool, _pids: &[u32]) -> CloseOutcome {
    CloseOutcome::Failed { error: "closing apps isn't supported on this OS".into() }
}
