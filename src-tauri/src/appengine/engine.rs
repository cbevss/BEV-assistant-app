//! The app engine: keeps the persistent index fresh and turns "open X" /
//! "close X" into resolved, verified actions. No Tauri types here, so it's
//! testable; mod.rs exposes it as commands.

use super::discover;
use super::launch::{self, CloseOutcome, LaunchOutcome};
use super::model::{merge, AppIndex, AppRecord, RawDiscovery};
use super::resolve::{resolve, search, store_link, Resolution};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// Rescan in the background when the index is older than this.
pub const STALE_MS: i64 = 12 * 3_600_000;
/// On a miss, rescan (to catch a just-installed app) at most this often.
pub const MISS_RESCAN_MS: i64 = 60_000;
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpenResult {
    Opened { app: String, window: String },
    AlreadyRunning { app: String, window: String, focused: bool },
    Starting { app: String, detail: String },
    Unverified { app: String, detail: String },
    Failed { app: String, error: String },
    Ambiguous { options: Vec<String> },
    NotInstalled { query: String, suggestions: Vec<String>, store_url: Option<String> },
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CloseResult {
    Closed { app: String },
    NotRunning { app: String },
    StillOpen { app: String, window: String },
    ForceClosed { app: String, processes: usize },
    Failed { app: String, error: String },
    Ambiguous { options: Vec<String> },
    NotInstalled { query: String },
}

#[derive(Serialize, Debug)]
pub struct IndexStatus {
    pub count: usize,
    pub scanned_at: i64,
    pub scanning: bool,
    pub last_error: Option<String>,
}

pub struct AppEngine {
    index: Mutex<AppIndex>,
    file: PathBuf,
    dir: PathBuf,
    scan_lock: Mutex<()>,
    scanning: std::sync::atomic::AtomicBool,
    last_error: Mutex<Option<String>>,
    miss_rescan_ms: i64,
    /// Injectable for tests: (scanner, launcher, closer).
    scanner: Box<dyn Fn(&std::path::Path) -> Result<RawDiscovery, String> + Send + Sync>,
    launcher: Box<dyn Fn(&AppRecord, Duration) -> LaunchOutcome + Send + Sync>,
    closer: Box<dyn Fn(&AppRecord, bool, &[u32]) -> CloseOutcome + Send + Sync>,
}

impl AppEngine {
    /// Load the saved index (if any) from `dir`.
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join("app-index.json");
        let index = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<AppIndex>(&b).ok()).unwrap_or_default();
        AppEngine {
            index: Mutex::new(index),
            file,
            dir,
            scan_lock: Mutex::new(()),
            scanning: Default::default(),
            last_error: Mutex::new(None),
            miss_rescan_ms: MISS_RESCAN_MS,
            scanner: Box::new(|d| discover::run(d)),
            launcher: Box::new(|a, t| launch::launch(a, t)),
            closer: Box::new(|a, f, p| launch::close(a, f, p)),
        }
    }

    #[cfg(test)]
    pub fn with_fakes(
        dir: PathBuf,
        scanner: impl Fn(&std::path::Path) -> Result<RawDiscovery, String> + Send + Sync + 'static,
        launcher: impl Fn(&AppRecord, Duration) -> LaunchOutcome + Send + Sync + 'static,
    ) -> Self {
        let mut e = Self::load(dir);
        e.scanner = Box::new(scanner);
        e.launcher = Box::new(launcher);
        e.closer = Box::new(|_, _, _| CloseOutcome::NotRunning);
        e.miss_rescan_ms = 0;
        e
    }

    pub fn status(&self) -> IndexStatus {
        let i = self.index.lock().unwrap();
        IndexStatus {
            count: i.apps.len(),
            scanned_at: i.scanned_at,
            scanning: self.scanning.load(std::sync::atomic::Ordering::Relaxed),
            last_error: self.last_error.lock().unwrap().clone(),
        }
    }

    pub fn apps(&self) -> Vec<AppRecord> {
        self.index.lock().unwrap().apps.clone()
    }

    pub fn is_stale(&self, now: i64) -> bool {
        let i = self.index.lock().unwrap();
        i.apps.is_empty() || now - i.scanned_at > STALE_MS
    }

    /// Full scan; replaces the index (so removed apps disappear) and saves it.
    pub fn scan(&self) -> Result<usize, String> {
        let _g = self.scan_lock.lock().unwrap();
        self.scanning.store(true, std::sync::atomic::Ordering::Relaxed);
        let r = (self.scanner)(&self.dir).map(|raw| merge(&raw, now_ms()));
        self.scanning.store(false, std::sync::atomic::Ordering::Relaxed);
        match r {
            Ok(idx) => {
                let n = idx.apps.len();
                if let Ok(json) = serde_json::to_vec(&idx) {
                    let _ = std::fs::create_dir_all(&self.dir);
                    let tmp = self.file.with_extension("json.tmp");
                    if std::fs::write(&tmp, json).is_ok() {
                        let _ = std::fs::rename(&tmp, &self.file);
                    }
                }
                *self.index.lock().unwrap() = idx;
                *self.last_error.lock().unwrap() = None;
                Ok(n)
            }
            Err(e) => {
                *self.last_error.lock().unwrap() = Some(e.clone());
                Err(e)
            }
        }
    }

    fn ensure_index(&self) -> Result<(), String> {
        if self.index.lock().unwrap().apps.is_empty() {
            self.scan()?;
        }
        Ok(())
    }

    /// Resolve, rescanning once on a miss in case the app was just installed.
    fn resolve_fresh(&self, query: &str) -> Result<Resolution, String> {
        self.ensure_index()?;
        let r = resolve(query, &self.apps());
        if matches!(r, Resolution::NotFound { .. }) && now_ms() - self.index.lock().unwrap().scanned_at >= self.miss_rescan_ms && self.scan().is_ok() {
            return Ok(resolve(query, &self.apps()));
        }
        Ok(r)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<(String, String, u32)>, String> {
        self.ensure_index()?;
        Ok(search(query, &self.apps(), limit).into_iter().map(|c| (c.app.name, format!("{:?}", c.app.kind).to_lowercase(), c.score)).collect())
    }

    pub fn open(&self, query: &str) -> Result<OpenResult, String> {
        let q = query.trim();
        if q.is_empty() {
            return Err("which app?".into());
        }
        Ok(match self.resolve_fresh(q)? {
            Resolution::Found { app, .. } => {
                let name = app.name.clone();
                match (self.launcher)(&app, LAUNCH_TIMEOUT) {
                    LaunchOutcome::Opened { window, .. } => OpenResult::Opened { app: name, window },
                    LaunchOutcome::AlreadyRunning { window, focused } => OpenResult::AlreadyRunning { app: name, window, focused },
                    LaunchOutcome::Starting { detail } => OpenResult::Starting { app: name, detail },
                    LaunchOutcome::Unverified { detail } => OpenResult::Unverified { app: name, detail },
                    LaunchOutcome::Failed { error } => OpenResult::Failed { app: name, error },
                }
            }
            Resolution::Ambiguous { options } => OpenResult::Ambiguous { options: options.into_iter().map(|c| c.app.name).collect() },
            Resolution::NotFound { suggestions } => OpenResult::NotInstalled {
                query: q.to_string(),
                suggestions: suggestions.into_iter().map(|c| c.app.name).collect(),
                store_url: store_link(q),
            },
        })
    }

    /// `pids_for_exe` lists running processes by image name (for force-close).
    pub fn close(&self, query: &str, force: bool, pids_for_exe: impl Fn(&str) -> Vec<u32>) -> Result<CloseResult, String> {
        Ok(match self.resolve_fresh(query.trim())? {
            Resolution::Found { app, .. } => {
                let name = app.name.clone();
                let mut pids = app.exe_name.as_deref().map(&pids_for_exe).unwrap_or_default();
                // Games and launcher shortcuts often don't record their exe
                // (or record the launcher's): fall back to a process named like
                // the app, so "Rocket League" finds RocketLeague.exe.
                if pids.is_empty() {
                    let squashed = squash_name(&app.name);
                    if squashed.len() >= 4 {
                        pids = pids_for_exe(&format!("{squashed}.exe"));
                    }
                }
                match (self.closer)(&app, force, &pids) {
                    CloseOutcome::Closed { .. } => CloseResult::Closed { app: name },
                    CloseOutcome::NotRunning => CloseResult::NotRunning { app: name },
                    CloseOutcome::StillOpen { window } => CloseResult::StillOpen { app: name, window },
                    CloseOutcome::ForceClosed { processes } => CloseResult::ForceClosed { app: name, processes },
                    CloseOutcome::Failed { error } => CloseResult::Failed { app: name, error },
                }
            }
            Resolution::Ambiguous { options } => CloseResult::Ambiguous { options: options.into_iter().map(|c| c.app.name).collect() },
            Resolution::NotFound { .. } => CloseResult::NotInstalled { query: query.trim().to_string() },
        })
    }
}

/// Lower-case letters and digits only: "Rocket League" → "rocketleague".
pub fn squash_name(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

#[cfg(test)]
mod squash_tests {
    use super::squash_name;
    #[test]
    fn squashes() {
        assert_eq!(squash_name("Rocket League"), "rocketleague");
        assert_eq!(squash_name("RocketLeague.exe"), "rocketleagueexe");
        assert_eq!(squash_name("Counter-Strike 2"), "counterstrike2");
    }
}
