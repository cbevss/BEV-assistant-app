//! Start with Windows, the fast way.
//!
//! A Run-key entry (what the autostart plugin writes) is held back by Windows
//! until Explorer has finished starting, often 10+ seconds after sign-in. A
//! Task Scheduler task with a logon trigger for this user starts BEV as soon
//! as the user signs in. The task runs as the user, not elevated, and needs no
//! admin rights. If Windows refuses to create it, the caller falls back to the
//! Run key.

use crate::error::{BevError, BevResult};

#[cfg(windows)]
const TASK: &str = "BEV Personal AI";

/// XML for a per-user, unelevated logon task. Values are XML-escaped.
pub fn task_xml(user: &str, exe: &str) -> String {
    let esc = |s: &str| {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts BEV when you sign in.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>{exe}</Command><Arguments>--minimized</Arguments></Exec>
  </Actions>
</Task>
"#,
        user = esc(user),
        exe = esc(exe)
    )
}

#[cfg(windows)]
fn schtasks(args: &[&str]) -> BevResult<std::process::Output> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("schtasks.exe")
        .args(args)
        .creation_flags(0x0800_0000) // no console window
        .output()
        .map_err(|e| BevError::Os(format!("schtasks: {e}")))
}

/// Is the fast-start task registered?
#[tauri::command]
pub fn fast_start_enabled() -> bool {
    #[cfg(windows)]
    {
        schtasks(&["/Query", "/TN", TASK]).map(|o| o.status.success()).unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        autostart_path().exists()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    false
}

#[cfg(target_os = "linux")]
fn autostart_path() -> std::path::PathBuf {
    crate::linux::config_dir().join("autostart").join("bev.desktop")
}

/// XDG autostart entry, used by KDE Plasma (and GNOME) at sign-in.
pub fn autostart_entry(exe: &str) -> String {
    let q = exe.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "[Desktop Entry]\nType=Application\nName=BEV\nComment=Starts BEV when you sign in.\nExec=\"{q}\" --minimized\nIcon=bev\nTerminal=false\nX-GNOME-Autostart-enabled=true\nX-KDE-autostart-phase=2\n"
    )
}

/// Register (or remove) the logon task. Errors when Windows won't allow it,
/// so the caller can use the Run key instead.
#[tauri::command]
pub fn set_fast_start(on: bool) -> BevResult<()> {
    #[cfg(windows)]
    {
        if !on {
            let _ = schtasks(&["/Delete", "/TN", TASK, "/F"]);
            return Ok(());
        }
        let exe = std::env::current_exe().map_err(|e| BevError::Os(format!("exe path: {e}")))?;
        let domain = std::env::var("USERDOMAIN").unwrap_or_default();
        let name = std::env::var("USERNAME").map_err(|_| BevError::Os("no user name".into()))?;
        let user = if domain.is_empty() { name } else { format!("{domain}\\{name}") };
        let xml = task_xml(&user, &exe.to_string_lossy());
        // schtasks wants the XML as a UTF-16 file with a BOM.
        let path = std::env::temp_dir().join("bev-start-task.xml");
        let mut bytes = vec![0xFF, 0xFE];
        for u in xml.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(&path, bytes).map_err(|e| BevError::Os(format!("write task: {e}")))?;
        let out = schtasks(&["/Create", "/TN", TASK, "/XML", &path.to_string_lossy(), "/F"]);
        let _ = std::fs::remove_file(&path);
        let out = out?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(BevError::Os(format!("Windows wouldn't create the start-up task: {msg}")));
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let path = autostart_path();
        if !on {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        }
        // An AppImage's own path changes each mount; $APPIMAGE is the real file.
        let exe = std::env::var("APPIMAGE")
            .map(std::path::PathBuf::from)
            .or_else(|_| std::env::current_exe())
            .map_err(|e| BevError::Os(format!("exe path: {e}")))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, autostart_entry(&exe.to_string_lossy()))?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = on;
        Err(BevError::Unsupported("start-up isn't supported on this OS".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::task_xml;
    #[test]
    fn escapes_and_fills() {
        let x = task_xml("PC\\Callum", r"C:\Users\A&B\BEV.exe");
        assert!(x.contains("<UserId>PC\\Callum</UserId>"));
        assert!(x.contains(r"C:\Users\A&amp;B\BEV.exe"));
        assert!(x.contains("<Arguments>--minimized</Arguments>"));
        assert!(x.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    }

    #[test]
    fn autostart_entry_quotes_exe() {
        let e = super::autostart_entry("/opt/My Apps/bev");
        assert!(e.contains("Exec=\"/opt/My Apps/bev\" --minimized"));
        assert!(e.starts_with("[Desktop Entry]"));
    }
}
