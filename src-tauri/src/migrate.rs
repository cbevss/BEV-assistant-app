//! BEV's folders used to be named after the app id (com.cbevss.bev). From 1.44
//! the id is "BEV", so they're %APPDATA%\BEV and %LOCALAPPDATA%\BEV. On start,
//! before anything opens them, the old folders are moved across so settings,
//! memories, logs and the WebView's saved data come along.
use std::path::Path;

pub const OLD_NAME: &str = "com.cbevss.bev";
pub const NEW_NAME: &str = "BEV";

/// Move `base/OLD_NAME` to `base/NEW_NAME` unless the new one already has data.
/// A new folder with nothing BEV saved in it (only created by a run that
/// couldn't move the old one, e.g. while the old version was still open) is
/// replaced. Never deletes the old folder's contents; failures are left for next start.
pub fn move_folder(base: &Path) -> bool {
    let old = base.join(OLD_NAME);
    let new = base.join(NEW_NAME);
    if !old.is_dir() {
        return false;
    }
    if new.exists() {
        let has_data = std::fs::read_dir(&new).map(|mut d| d.next().is_some()).unwrap_or(true);
        if has_data || std::fs::remove_dir(&new).is_err() {
            return false;
        }
    }
    std::fs::rename(&old, &new).is_ok()
}

/// Both of BEV's folders (roaming: settings, database, memories; local: WebView data).
pub fn run() {
    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            move_folder(Path::new(&base));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_old_folder_and_keeps_new_data() {
        let d = std::env::temp_dir().join(format!("bev-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(OLD_NAME)).unwrap();
        std::fs::write(d.join(OLD_NAME).join("settings.json"), "{}").unwrap();
        std::fs::create_dir_all(d.join(NEW_NAME)).unwrap(); // empty: made by a failed earlier start
        assert!(move_folder(&d));
        assert!(d.join(NEW_NAME).join("settings.json").exists());
        assert!(!d.join(OLD_NAME).exists());
        // Already moved: nothing to do, and existing data is never overwritten.
        std::fs::create_dir_all(d.join(OLD_NAME)).unwrap();
        std::fs::write(d.join(OLD_NAME).join("settings.json"), "old").unwrap();
        assert!(!move_folder(&d));
        assert_eq!(std::fs::read_to_string(d.join(NEW_NAME).join("settings.json")).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
