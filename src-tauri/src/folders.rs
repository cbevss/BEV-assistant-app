//! BEV's own folder in the user's home, kept tidy:
//!   C:\Users\<you>\BEV\Installers   updates BEV downloads (newest few kept)
//!   C:\Users\<you>\BEV\From phone   files sent from the phone
//! Easy to find, and narrow enough to exclude from an antivirus's checks.

use crate::error::{BevError, BevResult};
use std::path::PathBuf;
use tauri::Emitter;

pub const SUBFOLDERS: [&str; 2] = ["Installers", "From phone"];
const KEEP_INSTALLERS: usize = 3;

pub fn bev_home() -> BevResult<PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|_| BevError::Os("no home folder".into()))?;
    Ok(PathBuf::from(home).join("BEV"))
}

/// BEV\<sub>, made if it isn't there.
pub fn sub(name: &str) -> BevResult<PathBuf> {
    let dir = bev_home()?.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| BevError::Os(format!("make folder {}: {e}", dir.display())))?;
    Ok(dir)
}

/// Make the folder and its subfolders; returns its path.
#[tauri::command]
pub fn bev_folder() -> BevResult<String> {
    for s in SUBFOLDERS {
        sub(s)?;
    }
    Ok(bev_home()?.display().to_string())
}

/// Installers, newest first by name order of version; keeps the newest `keep`, returns the ones removed. Pure-ish; tested.
pub fn prune_installers(dir: &std::path::Path, keep: usize) -> Vec<PathBuf> {
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(dir)
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("BEV-Setup-") && e.file_name().to_string_lossy().ends_with(".exe"))
                .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
                .collect()
        })
        .unwrap_or_default();
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let gone: Vec<PathBuf> = files.into_iter().skip(keep).map(|(_, p)| p).collect();
    for p in &gone {
        let _ = std::fs::remove_file(p);
    }
    gone
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    got: usize,
    total: Option<u64>,
}

/// Download the newest signed update into BEV\Installers, then run it (quietly, then BEV restarts).
/// The signature is checked by the updater before anything is saved or run.
#[tauri::command]
pub async fn install_update_to_folder(app: tauri::AppHandle) -> BevResult<String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| BevError::Os(e.to_string()))?
        .check()
        .await
        .map_err(|e| BevError::Os(e.to_string()))?
        .ok_or_else(|| BevError::NotFound("no update available".into()))?;
    let mut got = 0usize;
    let app2 = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                got += chunk;
                let _ = app2.emit("bev://update-progress", Progress { got, total });
            },
            || {},
        )
        .await
        .map_err(|e| BevError::Os(e.to_string()))?;
    let dir = sub("Installers")?;
    let safe: String = update.version.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
    let path = dir.join(format!("BEV-Setup-{safe}.exe"));
    std::fs::write(&path, &bytes).map_err(|e| BevError::Os(format!("save installer: {e}")))?;
    prune_installers(&dir, KEEP_INSTALLERS);
    run_installer(&app, &path)?;
    Ok(path.display().to_string())
}

#[cfg(windows)]
fn run_installer(app: &tauri::AppHandle, path: &std::path::Path) -> BevResult<()> {
    // Same as Tauri's updater in passive mode: progress bar only, update in place, start BEV again after.
    std::process::Command::new(path)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| BevError::Os(format!("start installer: {e}")))?;
    app.exit(0);
    Ok(())
}

#[cfg(not(windows))]
fn run_installer(_app: &tauri::AppHandle, _path: &std::path::Path) -> BevResult<()> {
    Err(BevError::Os("installing from the BEV folder is for Windows".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_installers_only() {
        let d = std::env::temp_dir().join(format!("bev-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        for v in ["1.0.0", "1.1.0", "1.2.0", "1.3.0"] {
            std::fs::write(d.join(format!("BEV-Setup-{v}.exe")), v).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::fs::write(d.join("notes.txt"), "keep me").unwrap();
        let gone = prune_installers(&d, 3);
        assert_eq!(gone.len(), 1);
        assert!(gone[0].ends_with("BEV-Setup-1.0.0.exe"));
        assert!(d.join("BEV-Setup-1.3.0.exe").exists() && d.join("notes.txt").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
