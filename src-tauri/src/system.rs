//! System actions: lock, power (sleep/restart/shutdown), screenshots, and
//! opening Windows Settings pages. Power actions are marked sensitive in the
//! tool layer and always require user approval before they reach here.

use crate::error::{BevError, BevResult};

#[cfg(windows)]
fn hidden_cmd(program: &str, args: &[&str]) -> BevResult<std::process::ExitStatus> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Ok(std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()?)
}

#[tauri::command]
pub fn lock_pc() -> BevResult<()> {
    #[cfg(windows)]
    unsafe {
        windows::Win32::System::Shutdown::LockWorkStation()
            .map_err(|e| BevError::Os(format!("LockWorkStation: {e}")))
    }
    #[cfg(not(windows))]
    Err(BevError::Unsupported("lock is Windows-only".into()))
}

/// `action`: "sleep" | "restart" | "shutdown" | "cancel".
/// Restart/shutdown use a short countdown so `cancel` (shutdown /a) can abort.
#[tauri::command]
pub fn power_action(action: String, delay_secs: Option<u32>) -> BevResult<String> {
    let delay = delay_secs.unwrap_or(15).min(600).to_string();
    #[cfg(windows)]
    {
        match action.as_str() {
            "sleep" => unsafe {
                // bHibernate=false, bForce=false, bWakeupEventsDisabled=false
                if windows::Win32::System::Power::SetSuspendState(false, false, false).as_bool() {
                    Ok("sleeping".into())
                } else {
                    Err(BevError::Os("SetSuspendState refused".into()))
                }
            },
            "restart" | "shutdown" => {
                let flag = if action == "restart" { "/r" } else { "/s" };
                let st = hidden_cmd(
                    "shutdown",
                    &[flag, "/t", &delay, "/c", "BEV: scheduled by your request. Say 'BEV, cancel shutdown' to abort."],
                )?;
                if st.success() {
                    Ok(format!("{action} in {delay}s"))
                } else {
                    Err(BevError::Os(format!("shutdown.exe exited with {st}")))
                }
            }
            "cancel" => {
                let st = hidden_cmd("shutdown", &["/a"])?;
                if st.success() {
                    Ok("pending shutdown cancelled".into())
                } else {
                    Err(BevError::NotFound("no shutdown was pending".into()))
                }
            }
            other => Err(BevError::Invalid(format!("unknown power action: {other}"))),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (action, delay);
        Err(BevError::Unsupported("power actions are Windows-only".into()))
    }
}

/// Capture a monitor to a PNG in the temp dir and return its path. The caller
/// is responsible for deleting it (see `delete_temp_file`).
#[tauri::command]
pub fn take_screenshot(monitor: Option<usize>) -> BevResult<String> {
    let monitors = xcap::Monitor::all().map_err(|e| BevError::Os(format!("monitors: {e}")))?;
    if monitors.is_empty() {
        return Err(BevError::NotFound("no monitors".into()));
    }
    let idx = monitor.unwrap_or(0);
    let m = monitors
        .get(idx)
        .ok_or_else(|| BevError::Invalid(format!("monitor {idx} does not exist (have {})", monitors.len())))?;
    let img = m
        .capture_image()
        .map_err(|e| BevError::Os(format!("capture: {e}")))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("bev-screen-{stamp}.png"));
    img.save(&path).map_err(|e| BevError::Os(format!("save: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Delete a BEV temp file. Restricted to bev-screen-*.png inside the temp dir
/// so this can never be used to delete arbitrary files.
#[tauri::command]
pub fn delete_temp_file(path: String) -> BevResult<()> {
    let p = std::path::PathBuf::from(&path);
    let tmp = std::env::temp_dir();
    let ok_dir = p.parent().map(|d| d == tmp.as_path()).unwrap_or(false);
    let ok_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with("bev-screen-") && n.ends_with(".png"))
        .unwrap_or(false);
    if !(ok_dir && ok_name) {
        return Err(BevError::Invalid("not a BEV temp file".into()));
    }
    match std::fs::remove_file(&p) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Open a Windows Settings page, e.g. "display", "sound", "bluetooth".
#[tauri::command]
pub fn open_settings_page(page: String) -> BevResult<String> {
    let page = page.trim().to_lowercase();
    if !page.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(BevError::Invalid("invalid settings page".into()));
    }
    let uri = if page.is_empty() { "ms-settings:".to_string() } else { format!("ms-settings:{page}") };
    #[cfg(windows)]
    {
        let st = hidden_cmd("cmd", &["/C", "start", "", &uri])?;
        if st.success() {
            Ok(format!("opened {uri}"))
        } else {
            Err(BevError::NotFound(format!("could not open {uri}")))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = uri;
        Err(BevError::Unsupported("settings pages are Windows-only".into()))
    }
}

#[derive(serde::Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale: f32,
    pub primary: bool,
}

#[tauri::command]
pub fn list_monitors() -> BevResult<Vec<MonitorInfo>> {
    let monitors = xcap::Monitor::all().map_err(|e| BevError::Os(format!("monitors: {e}")))?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i,
            name: m.name().unwrap_or_default(),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            scale: m.scale_factor().unwrap_or(1.0),
            primary: m.is_primary().unwrap_or(false),
        })
        .collect())
}
