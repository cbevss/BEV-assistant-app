//! Which Windows mechanism launches a given record. Pure, so the choice is
//! tested; launch.rs carries it out.

use super::model::{AppKind, AppRecord};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchPlan {
    /// Store/MSIX app: IApplicationActivationManager with its AUMID (gives a PID).
    Activate { aumid: String },
    /// ShellExecuteEx on an exe, shortcut, URI or system tool.
    Shell { file: String, dir: Option<String> },
    /// Start-menu entry with no known exe: `shell:AppsFolder\<AppID>`.
    AppsFolder { app_id: String },
}

/// AppIDs / AUMIDs are plain identifiers; anything with quoting or control
/// characters is refused rather than passed to the shell.
fn safe_id(s: &str) -> bool {
    !s.is_empty() && s.len() < 512 && !s.chars().any(|c| c.is_control() || matches!(c, '"' | '<' | '>' | '|' | '&' | '^' | '%'))
}

pub fn plan(a: &AppRecord) -> Result<LaunchPlan, String> {
    if a.kind == AppKind::Packaged {
        if let Some(id) = a.app_id.as_deref().filter(|i| i.contains('!')) {
            return if safe_id(id) { Ok(LaunchPlan::Activate { aumid: id.to_string() }) } else { Err("unsafe app id".into()) };
        }
    }
    if let Some(uri) = &a.uri {
        return Ok(LaunchPlan::Shell { file: uri.clone(), dir: None });
    }
    if let Some(lnk) = &a.shortcut {
        return Ok(LaunchPlan::Shell { file: lnk.clone(), dir: None });
    }
    if let Some(exe) = &a.exe_path {
        let dir = exe.rfind('\\').map(|i| exe[..i].to_string()).filter(|d| !d.is_empty());
        return Ok(LaunchPlan::Shell { file: exe.clone(), dir });
    }
    if let Some(id) = &a.app_id {
        return if safe_id(id) { Ok(LaunchPlan::AppsFolder { app_id: id.clone() }) } else { Err("unsafe app id".into()) };
    }
    Err(format!("no way to launch {}", a.name))
}

/// Apps where "open X" means a new window even if one is already open.
pub fn multi_instance(a: &AppRecord) -> bool {
    const MULTI: &[&str] = &["explorer.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "wt.exe", "mmc.exe"];
    a.exe_name.as_deref().is_some_and(|n| MULTI.contains(&n.to_lowercase().as_str()))
        || a.uri.as_deref().is_some_and(|u| u.ends_with(".msc") || u.ends_with(".cpl"))
}
