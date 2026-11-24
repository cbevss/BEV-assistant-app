//! Open a file or folder the way double-clicking it in File Explorer would:
//! folders open in Explorer, files in their default app. The path goes to
//! explorer.exe as a single argument (never through a shell), and must be an
//! existing absolute path. Whether opening a program needs approval is decided
//! by the caller (the AI tool / routine step).

use crate::error::{BevError, BevResult};
use std::path::{Path, PathBuf};

/// Expand %VAR% (e.g. %USERPROFILE%\Downloads) and trim stray quotes.
pub(crate) fn expand(raw: &str) -> String {
    let s = raw.trim().trim_matches('"');
    // "~/Downloads" on Linux.
    #[cfg(unix)]
    let home_expanded;
    #[cfg(unix)]
    let s = if s == "~" || s.starts_with("~/") {
        home_expanded = format!("{}{}", std::env::var("HOME").unwrap_or_default(), &s[1..]);
        home_expanded.as_str()
    } else {
        s
    };
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Validate a path for opening: absolute and existing.
pub(crate) fn resolve(raw: &str) -> BevResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(BevError::Invalid("path is empty".into()));
    }
    let p = PathBuf::from(expand(raw));
    if !p.is_absolute() {
        return Err(BevError::Invalid(format!("use a full path, like C:\\Users\\you\\Downloads or ~/Downloads (got \"{}\")", p.display())));
    }
    if !p.exists() {
        return Err(BevError::NotFound(format!("{} doesn't exist", p.display())));
    }
    Ok(p)
}

fn display_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

#[tauri::command]
pub fn open_path(path: String) -> BevResult<String> {
    let p = resolve(&path)?;
    #[cfg(windows)]
    {
        // Ask Windows to "open" it, like double-clicking: folders go to whatever
        // file manager is set as default (File Explorer, Files, Directory Opus…),
        // files to their default app.
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let file = HSTRING::from(p.as_os_str());
        let r = unsafe { ShellExecuteW(windows::Win32::Foundation::HWND::default(), &HSTRING::from("open"), &file, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        if (r.0 as isize) <= 32 {
            // Nothing registered (or it refused): File Explorer always works.
            std::process::Command::new("explorer.exe")
                .arg(&p)
                .spawn()
                .map_err(|e| BevError::Os(format!("couldn't open {}: {e}", p.display())))?;
        }
        Ok(format!("opened {}", display_name(&p)))
    }
    #[cfg(target_os = "linux")]
    {
        let s = p.to_string_lossy().into_owned();
        crate::linux::spawn("xdg-open", &[&s])?;
        Ok(format!("opened {}", display_name(&p)))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = display_name(&p);
        Err(BevError::Unsupported("opening files isn't supported on this OS".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_environment_variables() {
        std::env::set_var("BEV_TEST_DIR", "/tmp/bev");
        assert_eq!(expand("%BEV_TEST_DIR%/Downloads"), "/tmp/bev/Downloads");
        assert_eq!(expand("\"%BEV_TEST_DIR%\""), "/tmp/bev");
        assert_eq!(expand("%NOT_A_REAL_VAR_XYZ%/x"), "%NOT_A_REAL_VAR_XYZ%/x");
        assert_eq!(expand("100% done"), "100% done");
    }

    #[test]
    fn rejects_relative_missing_and_empty_paths() {
        assert!(resolve("").is_err());
        assert!(resolve("Downloads").is_err());
        assert!(resolve("/definitely/not/here/bev").is_err());
        let dir = std::env::temp_dir();
        assert_eq!(resolve(&dir.display().to_string()).unwrap(), dir);
    }
}
