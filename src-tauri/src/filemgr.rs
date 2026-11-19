//! File management for BEV: look in folders, find files, move/rename, copy,
//! make folders, and send things to the Recycle Bin.
//!
//! Guard rails (enforced here, whatever the caller asks):
//! - Never inside Windows, Program Files, ProgramData or AppData, and never in
//!   `$Recycle.Bin` / `System Volume Information`.
//! - A drive, the user's profile folder or a top-level personal folder
//!   (Desktop, Documents, Downloads…) can be looked in and moved *into*, but
//!   never moved, renamed or binned itself.
//! - Nothing is overwritten: a name clash becomes "name (2).ext".
//! - Nothing is deleted outright: deleting means the Recycle Bin.

use crate::error::{BevError, BevResult};
use crate::files::expand;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_LIST: usize = 2000;
const MAX_FIND: usize = 200;
const MAX_VISIT: usize = 60_000;
const MAX_BATCH: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: u64,
    /// Last modified, ms since 1970.
    pub modified: i64,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Move {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
pub struct Failed {
    pub from: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
pub struct BatchResult {
    /// What actually happened (`to` is where it ended up, after any rename).
    pub done: Vec<Move>,
    pub failed: Vec<Failed>,
}

// ---------------------------------------------------------------------------
// Where BEV may work

pub(crate) struct Guard {
    /// No reading or writing at or under these.
    forbidden: Vec<String>,
    /// Can't be moved, renamed or binned themselves.
    roots: Vec<String>,
}

/// Lower-case, forward-slash, no trailing slash, no `\\?\` prefix.
fn norm(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).to_string();
    let s = s.trim_end_matches('/').to_lowercase();
    if s.is_empty() { "/".into() } else { s }
}

fn under(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

impl Guard {
    pub(crate) fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let mut forbidden = Vec::new();
        for k in ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"] {
            if let Some(v) = env(k) {
                forbidden.push(norm(Path::new(&v)));
            }
        }
        let mut roots = Vec::new();
        if let Some(home) = env("USERPROFILE").or_else(|| env("HOME")) {
            let h = Path::new(&home);
            forbidden.push(norm(&h.join("AppData")));
            roots.push(norm(h));
            for f in ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "OneDrive", "Saved Games", "3D Objects", "Contacts", "Favorites", "Links", "Searches"] {
                roots.push(norm(&h.join(f)));
            }
        }
        if let Some(od) = env("OneDrive") {
            roots.push(norm(Path::new(&od)));
        }
        Self { forbidden, roots }
    }

    #[cfg(test)]
    fn new(forbidden: &[&str], roots: &[&str]) -> Self {
        Self { forbidden: forbidden.iter().map(|s| norm(Path::new(s))).collect(), roots: roots.iter().map(|s| norm(Path::new(s))).collect() }
    }

    /// May BEV look at or write to this path?
    fn usable(&self, p: &Path) -> Result<(), String> {
        let n = norm(p);
        if p.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err("paths can't contain \"..\"".into());
        }
        if p.components().any(|c| {
            let s = c.as_os_str().to_string_lossy().to_lowercase();
            s == "$recycle.bin" || s == "system volume information"
        }) {
            return Err(format!("{} is a system folder", p.display()));
        }
        if let Some(f) = self.forbidden.iter().find(|f| under(&n, f)) {
            return Err(format!("{} is inside a system folder ({f}), which BEV leaves alone", p.display()));
        }
        Ok(())
    }

    /// May BEV move, rename or bin this path itself?
    fn movable(&self, p: &Path) -> Result<(), String> {
        self.usable(p)?;
        let n = norm(p);
        if p.parent().is_none() || self.roots.iter().any(|r| *r == n) {
            return Err(format!("{} is a main folder; BEV can work inside it but won't move or delete it", p.display()));
        }
        Ok(())
    }
}

fn full(raw: &str) -> BevResult<PathBuf> {
    if raw.trim().is_empty() {
        return Err(BevError::Invalid("path is empty".into()));
    }
    let p = PathBuf::from(expand(raw));
    if !p.is_absolute() {
        return Err(BevError::Invalid(format!("use a full path, like C:\\Users\\you\\Downloads (got \"{}\")", p.display())));
    }
    Ok(p)
}

// ---------------------------------------------------------------------------
// Reading

fn entry(p: &Path, md: &std::fs::Metadata) -> Entry {
    Entry {
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string()),
        path: p.display().to_string(),
        dir: md.is_dir(),
        size: if md.is_dir() { 0 } else { md.len() },
        modified: md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0),
    }
}

/// Clutter nobody means when they talk about their files.
fn noise(name: &str) -> bool {
    let l = name.to_lowercase();
    l == "desktop.ini" || l == "thumbs.db" || l.starts_with("~$") || l.starts_with('.')
}

/// Folders a search never walks into.
fn skip_dir(name: &str) -> bool {
    let l = name.to_lowercase();
    matches!(l.as_str(), "node_modules" | "appdata" | "$recycle.bin" | "system volume information" | "__pycache__" | "target") || l.starts_with('.')
}

pub(crate) fn list_in(g: &Guard, dir: &Path, depth: u8) -> BevResult<Listing> {
    g.usable(dir).map_err(BevError::Invalid)?;
    if !dir.is_dir() {
        return Err(BevError::NotFound(format!("{} isn't a folder", dir.display())));
    }
    let mut out = Listing { entries: Vec::new(), truncated: false };
    let mut stack = vec![(dir.to_path_buf(), 0u8)];
    while let Some((d, level)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        let mut kids: Vec<_> = rd.flatten().collect();
        kids.sort_by_key(|e| e.file_name());
        for e in kids {
            let name = e.file_name().to_string_lossy().into_owned();
            if noise(&name) {
                continue;
            }
            let p = e.path();
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() {
                continue;
            }
            if out.entries.len() >= MAX_LIST {
                out.truncated = true;
                return Ok(out);
            }
            out.entries.push(entry(&p, &md));
            if md.is_dir() && level < depth && !skip_dir(&name) && g.usable(&p).is_ok() {
                stack.push((p, level + 1));
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Default, Deserialize)]
pub struct FindQuery {
    /// Words that must all appear in the name (any order). May be empty if
    /// another filter is given.
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub roots: Vec<String>,
    /// Extensions without dots, e.g. ["pdf", "docx"].
    #[serde(default)]
    pub ext: Vec<String>,
    /// Only things changed in the last N days.
    pub days: Option<u32>,
    /// Only files at least this many MB.
    pub min_mb: Option<u64>,
    #[serde(default)]
    pub folders: bool,
}

pub(crate) fn find_in(g: &Guard, q: &FindQuery, roots: &[PathBuf], now_ms: i64) -> Vec<Entry> {
    let words: Vec<String> = q.query.to_lowercase().split_whitespace().map(str::to_string).collect();
    let exts: Vec<String> = q.ext.iter().map(|e| e.trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty()).collect();
    let since = q.days.map(|d| now_ms - d as i64 * 86_400_000);
    let min = q.min_mb.map(|m| m * 1024 * 1024);
    let mut hits = Vec::new();
    let mut visited = 0usize;
    let mut stack: Vec<(PathBuf, u8)> = roots.iter().filter(|r| g.usable(r).is_ok()).map(|r| (r.clone(), 0)).collect();
    while let Some((d, level)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            visited += 1;
            if visited > MAX_VISIT {
                return sorted(hits);
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if noise(&name) {
                continue;
            }
            let p = e.path();
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() {
                continue;
            }
            if md.is_dir() {
                if level < 8 && !skip_dir(&name) && g.usable(&p).is_ok() {
                    stack.push((p.clone(), level + 1));
                }
                if !q.folders {
                    continue;
                }
            } else if q.folders {
                continue;
            }
            let lname = name.to_lowercase();
            if !words.iter().all(|w| lname.contains(w)) {
                continue;
            }
            if !exts.is_empty() && !exts.iter().any(|x| lname.ends_with(&format!(".{x}"))) {
                continue;
            }
            let en = entry(&p, &md);
            if since.is_some_and(|s| en.modified < s) || min.is_some_and(|m| en.size < m) {
                continue;
            }
            hits.push(en);
        }
    }
    sorted(hits)
}

/// Newest first, capped.
fn sorted(mut hits: Vec<Entry>) -> Vec<Entry> {
    hits.sort_by(|a, b| b.modified.cmp(&a.modified));
    hits.truncate(MAX_FIND);
    hits
}

// ---------------------------------------------------------------------------
// Changing

/// "report.pdf" → "report (2).pdf" until the name is free.
pub(crate) fn free_name(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let parent = target.parent().unwrap_or(Path::new(""));
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..10_000).map(|n| parent.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or_else(|| target.to_path_buf())
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Where `from` lands for a requested `to`: inside `to` if it's an existing
/// folder, otherwise at `to` itself; then made unique.
fn destination(from: &Path, to: &Path) -> PathBuf {
    let t = if to.is_dir() { to.join(from.file_name().unwrap_or_default()) } else { to.to_path_buf() };
    if norm(&t) == norm(from) { t } else { free_name(&t) }
}

pub(crate) fn transfer(g: &Guard, items: &[Move], copy: bool) -> BevResult<BatchResult> {
    if items.len() > MAX_BATCH {
        return Err(BevError::Invalid(format!("that's {} items; do at most {MAX_BATCH} at a time", items.len())));
    }
    let mut res = BatchResult { done: Vec::new(), failed: Vec::new() };
    for m in items {
        let attempt = (|| -> Result<PathBuf, String> {
            let from = full(&m.from).map_err(|e| e.to_string())?;
            let to = full(&m.to).map_err(|e| e.to_string())?;
            if copy { g.usable(&from)? } else { g.movable(&from)? }
            if !from.exists() {
                return Err(format!("{} doesn't exist", from.display()));
            }
            let dest = destination(&from, &to);
            g.usable(&dest)?;
            if norm(&dest) == norm(&from) {
                return Ok(dest); // already there
            }
            if from.is_dir() && under(&norm(&dest), &norm(&from)) {
                return Err("can't put a folder inside itself".into());
            }
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("couldn't make {}: {e}", parent.display()))?;
            }
            if copy {
                copy_tree(&from, &dest).map_err(|e| format!("couldn't copy: {e}"))?;
            } else if std::fs::rename(&from, &dest).is_err() {
                // Different drive: copy, then remove the original only once the copy is whole.
                copy_tree(&from, &dest).map_err(|e| format!("couldn't move: {e}"))?;
                let removed = if from.is_dir() { std::fs::remove_dir_all(&from) } else { std::fs::remove_file(&from) };
                removed.map_err(|e| format!("copied to {}, but couldn't remove the original: {e}", dest.display()))?;
            }
            Ok(dest)
        })();
        match attempt {
            Ok(dest) => res.done.push(Move { from: m.from.clone(), to: dest.display().to_string() }),
            Err(error) => res.failed.push(Failed { from: m.from.clone(), error }),
        }
    }
    Ok(res)
}

pub(crate) fn make_folder(g: &Guard, raw: &str) -> BevResult<String> {
    let p = full(raw)?;
    g.usable(&p).map_err(BevError::Invalid)?;
    std::fs::create_dir_all(&p)?;
    Ok(p.display().to_string())
}

pub(crate) fn bin(g: &Guard, paths: &[String]) -> BevResult<BatchResult> {
    if paths.len() > MAX_BATCH {
        return Err(BevError::Invalid(format!("that's {} items; do at most {MAX_BATCH} at a time", paths.len())));
    }
    let mut res = BatchResult { done: Vec::new(), failed: Vec::new() };
    for raw in paths {
        let attempt = (|| -> Result<(), String> {
            let p = full(raw).map_err(|e| e.to_string())?;
            g.movable(&p)?;
            if !p.exists() {
                return Err(format!("{} doesn't exist", p.display()));
            }
            trash::delete(&p).map_err(|e| format!("couldn't move it to the Recycle Bin: {e}"))
        })();
        match attempt {
            Ok(()) => res.done.push(Move { from: raw.clone(), to: "Recycle Bin".into() }),
            Err(error) => res.failed.push(Failed { from: raw.clone(), error }),
        }
    }
    Ok(res)
}

// ---------------------------------------------------------------------------
// Commands

fn personal_folders() -> Vec<PathBuf> {
    let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) else { return vec![] };
    let h = PathBuf::from(home);
    let mut v: Vec<PathBuf> = ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"].iter().map(|f| h.join(f)).filter(|p| p.is_dir()).collect();
    if let Ok(od) = std::env::var("OneDrive") {
        let od = PathBuf::from(od);
        if od.is_dir() {
            v.push(od);
        }
    }
    v
}

#[tauri::command]
pub fn files_list(path: String, depth: Option<u8>) -> BevResult<Listing> {
    list_in(&Guard::from_env(), &full(&path)?, depth.unwrap_or(0).min(3))
}

#[tauri::command]
pub async fn files_find(query: FindQuery) -> BevResult<Vec<Entry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots: Vec<PathBuf> = if query.roots.is_empty() { personal_folders() } else { query.roots.iter().filter_map(|r| full(r).ok()).collect() };
        let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        find_in(&Guard::from_env(), &query, &roots, now)
    })
    .await
    .map_err(|e| BevError::Os(e.to_string()))
}

#[tauri::command]
pub async fn files_move(items: Vec<Move>, copy: Option<bool>) -> BevResult<BatchResult> {
    tauri::async_runtime::spawn_blocking(move || transfer(&Guard::from_env(), &items, copy.unwrap_or(false))).await.map_err(|e| BevError::Os(e.to_string()))?
}

#[tauri::command]
pub fn files_mkdir(path: String) -> BevResult<String> {
    make_folder(&Guard::from_env(), &path)
}

#[tauri::command]
pub async fn files_trash(paths: Vec<String>) -> BevResult<BatchResult> {
    tauri::async_runtime::spawn_blocking(move || bin(&Guard::from_env(), &paths)).await.map_err(|e| BevError::Os(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bev-filemgr-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn guard_blocks_system_and_main_folders() {
        let g = Guard::new(&["/win", "/home/me/AppData"], &["/home/me", "/home/me/Downloads"]);
        assert!(g.usable(Path::new("/win/System32")).is_err());
        assert!(g.usable(Path::new("/home/me/appdata/Roaming")).is_err(), "case-insensitive");
        assert!(g.usable(Path::new("/home/me/Downloads/../AppData")).is_err());
        assert!(g.usable(Path::new("/d/$RECYCLE.BIN/x")).is_err());
        assert!(g.usable(Path::new("/home/me/Downloads/a.pdf")).is_ok());
        assert!(g.movable(Path::new("/home/me/Downloads")).is_err());
        assert!(g.movable(Path::new("/home/me")).is_err());
        assert!(g.movable(Path::new("/")).is_err());
        assert!(g.movable(Path::new("/home/me/Downloads/a.pdf")).is_ok());
        assert!(g.usable(Path::new("/windows-games")).is_ok(), "prefix must end at a folder boundary");
    }

    #[test]
    fn free_name_never_overwrites() {
        let d = tmp("free");
        let a = d.join("report.pdf");
        assert_eq!(free_name(&a), a);
        std::fs::write(&a, "x").unwrap();
        assert_eq!(free_name(&a), d.join("report (2).pdf"));
        std::fs::write(d.join("report (2).pdf"), "x").unwrap();
        assert_eq!(free_name(&a), d.join("report (3).pdf"));
    }

    #[test]
    fn moves_into_folders_renames_and_reports_failures() {
        let d = tmp("move");
        let g = Guard::new(&[], &[]);
        std::fs::write(d.join("a.txt"), "a").unwrap();
        std::fs::write(d.join("b.txt"), "b").unwrap();
        std::fs::create_dir(d.join("Docs")).unwrap();
        std::fs::write(d.join("Docs/a.txt"), "old").unwrap();
        let s = |p: PathBuf| p.display().to_string();
        let r = transfer(
            &g,
            &[
                Move { from: s(d.join("a.txt")), to: s(d.join("Docs")) },
                Move { from: s(d.join("b.txt")), to: s(d.join("New/renamed.txt")) },
                Move { from: s(d.join("missing.txt")), to: s(d.join("Docs")) },
            ],
            false,
        )
        .unwrap();
        assert_eq!(r.done.len(), 2);
        assert_eq!(r.done[0].to, s(d.join("Docs/a (2).txt")));
        assert_eq!(std::fs::read_to_string(d.join("Docs/a.txt")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(d.join("New/renamed.txt")).unwrap(), "b");
        assert_eq!(r.failed.len(), 1);
        assert!(!d.join("a.txt").exists());
    }

    #[test]
    fn copy_keeps_original_and_folder_cant_go_inside_itself() {
        let d = tmp("copy");
        let g = Guard::new(&[], &[]);
        std::fs::create_dir_all(d.join("Proj/sub")).unwrap();
        std::fs::write(d.join("Proj/sub/x.txt"), "x").unwrap();
        let s = |p: PathBuf| p.display().to_string();
        let r = transfer(&g, &[Move { from: s(d.join("Proj")), to: s(d.join("Backup")) }], true).unwrap();
        assert!(r.failed.is_empty(), "{:?}", r.failed);
        assert!(d.join("Proj/sub/x.txt").exists() && d.join("Backup/sub/x.txt").exists());
        let r = transfer(&g, &[Move { from: s(d.join("Proj")), to: s(d.join("Proj/sub")) }], false).unwrap();
        assert_eq!(r.failed.len(), 1);
        assert!(d.join("Proj").exists());
    }

    #[test]
    fn find_filters_by_words_type_age_and_skips_noise() {
        let d = tmp("find");
        let g = Guard::new(&[], &[]);
        std::fs::create_dir_all(d.join("deep/node_modules")).unwrap();
        std::fs::write(d.join("Tax Return 2025.pdf"), "x").unwrap();
        std::fs::write(d.join("deep/tax notes.txt"), "x").unwrap();
        std::fs::write(d.join("deep/node_modules/tax.pdf"), "x").unwrap();
        std::fs::write(d.join("desktop.ini"), "x").unwrap();
        let q = FindQuery { query: "tax".into(), ..Default::default() };
        let now = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let names: Vec<String> = find_in(&g, &q, &[d.clone()], now).into_iter().map(|e| e.name).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        let q = FindQuery { query: "return tax".into(), ext: vec![".PDF".into()], days: Some(1), ..Default::default() };
        assert_eq!(find_in(&g, &q, &[d.clone()], now).len(), 1);
        let q = FindQuery { query: "tax".into(), days: Some(1), ..Default::default() };
        assert_eq!(find_in(&g, &q, &[d.clone()], now + 3 * 86_400_000).len(), 0);
        let listing = list_in(&g, &d, 0).unwrap();
        assert!(listing.entries.iter().all(|e| e.name != "desktop.ini"));
        assert_eq!(listing.entries.len(), 2);
    }
}
