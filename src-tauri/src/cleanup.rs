//! Free space by clearing old temporary files from the user's temp folder
//! (%TEMP%). Only files untouched for 2+ days; files in use are skipped.
//! A dry run reports what would go, so the user approves the real thing.

use crate::error::{BevError, BevResult};
use serde::Serialize;
use std::path::Path;
use std::time::{Duration, SystemTime};

const MIN_AGE: Duration = Duration::from_secs(2 * 86_400);
const MAX_ENTRIES: usize = 300_000;

#[derive(Serialize, Default, Debug)]
pub struct CleanReport {
    pub files: u64,
    pub bytes: u64,
    /// In use or not allowed.
    pub skipped: u64,
    pub folder: String,
}

fn old_enough(md: &std::fs::Metadata, now: SystemTime) -> bool {
    md.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= MIN_AGE)
}

/// Walk `root`; delete (when `apply`) files older than MIN_AGE, then empty old folders.
pub(crate) fn clean(root: &Path, apply: bool, now: SystemTime) -> CleanReport {
    let mut rep = CleanReport { folder: root.display().to_string(), ..Default::default() };
    let mut dirs = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                return rep;
            }
            let p = e.path();
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() {
                continue; // never follow links out of the temp folder
            }
            if md.is_dir() {
                dirs.push(p.clone());
                stack.push(p);
            } else if old_enough(&md, now) {
                if !apply {
                    rep.files += 1;
                    rep.bytes += md.len();
                } else if std::fs::remove_file(&p).is_ok() {
                    rep.files += 1;
                    rep.bytes += md.len();
                } else {
                    rep.skipped += 1;
                }
            }
        }
    }
    if apply {
        // Deepest first; remove_dir only removes empty folders.
        dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
        for d in dirs {
            if std::fs::symlink_metadata(&d).is_ok_and(|m| old_enough(&m, now)) {
                let _ = std::fs::remove_dir(&d);
            }
        }
    }
    rep
}

#[tauri::command]
pub async fn clean_temp(apply: bool) -> BevResult<CleanReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = std::env::temp_dir();
        // Only ever a folder called Temp/tmp: never a drive root or a home folder.
        let name = t.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if t.parent().is_none() || !(name == "temp" || name == "tmp") {
            return Err(BevError::Invalid(format!("the temp folder looks unusual ({}), so BEV won't clear it", t.display())));
        }
        Ok(clean(&t, apply, SystemTime::now()))
    })
    .await
    .map_err(|e| BevError::Os(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_old_files_and_empty_old_folders_go() {
        let root = std::env::temp_dir().join(format!("bev-clean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("old.txt"), "12345").unwrap();
        std::fs::write(root.join("a/b/old2.txt"), "123").unwrap();
        std::fs::write(root.join("new.txt"), "x").unwrap();
        // Pretend it's 3 days from now: everything is "old" except what we touch after.
        let later = SystemTime::now() + Duration::from_secs(3 * 86_400);
        let dry = clean(&root, false, later);
        assert_eq!((dry.files, dry.bytes), (3, 9));
        assert!(root.join("old.txt").exists(), "a dry run deletes nothing");
        let soon = SystemTime::now() + Duration::from_secs(3600);
        assert_eq!(clean(&root, true, soon).files, 0, "nothing is old enough an hour from now");
        let done = clean(&root, true, later);
        assert_eq!(done.files, 3);
        assert!(!root.join("a").exists(), "empty old folders are removed");
        assert!(root.exists(), "the temp folder itself stays");
        let _ = std::fs::remove_dir_all(&root);
    }
}
