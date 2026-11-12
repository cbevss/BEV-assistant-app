//! Application launch / close / enumerate. Launch resolves a friendly name to
//! an executable via the Windows "App Paths" registry and PATH, then uses the
//! shell to open it. No arbitrary shell strings are ever executed — the AI
//! passes an app name, not a command line.

use crate::error::{BevError, BevResult};
use serde::Serialize;

/// Known friendly aliases → launch targets. Extend from the Integrations page.
fn resolve_target(name: &str) -> String {
    let n = name.trim().to_lowercase();
    match n.as_str() {
        "spotify" => "spotify".into(),
        "discord" => "discord".into(),
        "chrome" | "google chrome" => "chrome".into(),
        "edge" => "msedge".into(),
        "firefox" => "firefox".into(),
        "notepad" => "notepad".into(),
        "calculator" | "calc" => "calc".into(),
        "explorer" | "files" => "explorer".into(),
        "steam" => "steam".into(),
        "obs" | "obs studio" => "obs64".into(),
        "settings" => "ms-settings:".into(),
        "task manager" => "taskmgr".into(),
        other => other.into(),
    }
}

/// Launch via `cmd /C start` so the Windows shell resolves App Paths, UWP
/// aliases and `ms-settings:` URIs. Validated: no user-supplied flags.
#[tauri::command]
pub fn launch_app(name: String) -> BevResult<String> {
    if name.trim().is_empty() {
        return Err(BevError::Invalid("app name is empty".into()));
    }
    // Reject anything that looks like an attempt to smuggle a command line.
    if name.contains('&') || name.contains('|') || name.contains('>') || name.contains('\n') {
        return Err(BevError::Invalid("illegal characters in app name".into()));
    }
    let target = resolve_target(&name);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "", &target])
            .creation_flags(CREATE_NO_WINDOW)
            .status()?;
        if status.success() {
            Ok(format!("launched {name}"))
        } else {
            Err(BevError::NotFound(format!("could not launch {name}")))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err(BevError::Unsupported("launch is Windows-only".into()))
    }
}

/// Close processes by image name (e.g. "spotify" → spotify.exe). Best-effort;
/// returns how many were asked to close.
#[tauri::command]
pub fn close_app(name: String) -> BevResult<String> {
    if name.trim().is_empty() {
        return Err(BevError::Invalid("app name is empty".into()));
    }
    let image = {
        let t = resolve_target(&name);
        if t.ends_with(".exe") { t } else { format!("{t}.exe") }
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = std::process::Command::new("taskkill")
            .args(["/IM", &image, "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()?;
        if status.success() {
            Ok(format!("closed {name}"))
        } else {
            Err(BevError::NotFound(format!("{name} was not running")))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = image;
        Err(BevError::Unsupported("close is Windows-only".into()))
    }
}

#[derive(Serialize)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
}

#[tauri::command]
pub fn list_processes(state: tauri::State<crate::AppState>) -> BevResult<Vec<ProcInfo>> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut v: Vec<ProcInfo> = sys
        .processes()
        .values()
        .map(|p| ProcInfo {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().into_owned(),
        })
        .collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v.dedup_by(|a, b| a.name == b.name);
    Ok(v)
}
