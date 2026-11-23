//! Small helpers for the Linux (Fedora KDE / Plasma 6 on Wayland) port.

#![cfg(target_os = "linux")]

use crate::error::{BevError, BevResult};
use std::process::{Command, Stdio};

/// Run a program to completion, returning stdout. Non-zero exit is an error
/// carrying stderr.
pub fn run(program: &str, args: &[&str]) -> BevResult<String> {
    let out = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| BevError::Os(format!("{program}: {e}")))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(BevError::Os(format!("{program} failed: {err}")))
    }
}

/// Start a program and don't wait for it (apps, file managers).
pub fn spawn(program: &str, args: &[&str]) -> BevResult<()> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| BevError::Os(format!("{program}: {e}")))
}

/// Is a program on PATH?
pub fn has(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(program).is_file()))
        .unwrap_or(false)
}

/// The user's XDG config dir (~/.config).
pub fn config_dir() -> std::path::PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(Into::into)
        .unwrap_or_else(|| home().join(".config"))
}

pub fn home() -> std::path::PathBuf {
    std::env::var_os("HOME").map(Into::into).unwrap_or_else(|| "/".into())
}

/// Map a Windows-style settings page name to a KDE System Settings module.
pub fn kcm_for(page: &str) -> Option<&'static str> {
    Some(match page {
        "" => return None,
        "display" | "screenrotation" | "nightlight" => "kcm_kscreen",
        "sound" | "apps-volume" => "kcm_pulseaudio",
        "bluetooth" | "connecteddevices" => "kcm_bluetooth",
        "network" | "network-wifi" | "network-status" | "network-ethernet" | "network-vpn" => "kcm_networkmanagement",
        "personalization" | "colors" | "themes" => "kcm_colors",
        "personalization-background" | "lockscreen" => "kcm_screenlocker",
        "taskbar" => "kcm_desktoptheme",
        "mousetouchpad" | "mouse" => "kcm_mouse",
        "devices-touchpad" => "kcm_touchpad",
        "keyboard" | "typing" => "kcm_keyboard",
        "powersleep" | "batterysaver" => "kcm_powerdevilprofilesconfig",
        "dateandtime" | "regionformatting" => "kcm_clock",
        "language" => "kcm_regionandlang",
        "notifications" => "kcm_notifications",
        "printers" => "kcm_printer_manager",
        "defaultapps" => "kcm_componentchooser",
        "startupapps" => "kcm_autostart",
        "accounts" | "yourinfo" => "kcm_users",
        "about" => "kcm_about-distro",
        "privacy" => "kcm_activities",
        "easeofaccess" => "kcm_access",
        "fonts" => "kcm_fonts",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::kcm_for;
    #[test]
    fn maps_common_pages() {
        assert_eq!(kcm_for("display"), Some("kcm_kscreen"));
        assert_eq!(kcm_for("sound"), Some("kcm_pulseaudio"));
        assert_eq!(kcm_for(""), None);
        assert_eq!(kcm_for("nonsense"), None);
    }
}
