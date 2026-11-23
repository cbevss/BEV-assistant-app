//! Windows Application Resolution and Execution Engine.
//!
//! discover (scan Windows) → model (merge into an index, persisted) →
//! resolve (what the user meant) → launchplan (how to start it) →
//! launch (start it and verify what happened). See docs/AUDIT.md.

pub mod desktop;
pub mod discover;
pub mod engine;
pub mod launch;
pub mod launchplan;
pub mod model;
pub mod resolve;
#[cfg(test)]
mod tests;

use crate::error::{BevError, BevResult};
use engine::{AppEngine, CloseResult, IndexStatus, OpenResult};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

pub type Engine = Arc<AppEngine>;

/// Load the saved index and, if it's missing or stale, rescan in the
/// background so BEV starts instantly.
pub fn start(dir: std::path::PathBuf) -> Engine {
    let e = Arc::new(AppEngine::load(dir));
    if e.is_stale(engine::now_ms()) {
        let bg = e.clone();
        std::thread::spawn(move || {
            if let Err(err) = bg.scan() {
                log::warn!("app index scan failed: {err}");
            }
        });
    }
    e
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> BevResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| BevError::Os(e.to_string()))?.map_err(BevError::Os)
}

#[tauri::command]
pub async fn apps_open(engine: State<'_, Engine>, query: String) -> BevResult<OpenResult> {
    let e = engine.inner().clone();
    blocking(move || e.open(&query)).await
}

#[tauri::command]
pub async fn apps_close(
    engine: State<'_, Engine>,
    app_state: State<'_, crate::AppState>,
    query: String,
    force: Option<bool>,
) -> BevResult<CloseResult> {
    // Running processes by image name, for a force close.
    let procs: Vec<(String, u32)> = {
        let mut sys = app_state.sys.lock().unwrap();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        sys.processes().values().map(|p| (p.name().to_string_lossy().to_lowercase(), p.pid().as_u32())).collect()
    };
    let e = engine.inner().clone();
    let force = force.unwrap_or(false);
    blocking(move || {
        e.close(&query, force, |exe| {
            let exe = exe.to_lowercase();
            let squashed = engine::squash_name(&exe);
            // Exact image name, or the same name ignoring spaces and punctuation.
            procs.iter().filter(|(n, _)| *n == exe || engine::squash_name(n) == squashed).map(|(_, p)| *p).collect()
        })
    })
    .await
}

#[derive(Serialize)]
pub struct SearchHit {
    pub name: String,
    pub kind: String,
    pub score: u32,
}

#[tauri::command]
pub async fn apps_search(engine: State<'_, Engine>, query: String, limit: Option<usize>) -> BevResult<Vec<SearchHit>> {
    let e = engine.inner().clone();
    let limit = limit.unwrap_or(8).min(25);
    blocking(move || Ok(e.search(&query, limit)?.into_iter().map(|(name, kind, score)| SearchHit { name, kind, score }).collect())).await
}

#[tauri::command]
pub async fn apps_refresh(engine: State<'_, Engine>) -> BevResult<usize> {
    let e = engine.inner().clone();
    blocking(move || e.scan()).await
}

#[tauri::command]
pub fn apps_status(engine: State<'_, Engine>) -> IndexStatus {
    engine.status()
}

#[derive(Serialize)]
pub struct AppRow {
    pub name: String,
    pub kind: model::AppKind,
    pub source: String,
    pub exe_name: Option<String>,
    pub aliases: Vec<String>,
}

#[tauri::command]
pub fn apps_list(engine: State<'_, Engine>) -> Vec<AppRow> {
    let mut v: Vec<AppRow> = engine
        .apps()
        .into_iter()
        .map(|a| AppRow { name: a.name, kind: a.kind, source: a.source, exe_name: a.exe_name, aliases: a.aliases })
        .collect();
    v.sort_by_key(|a| a.name.to_lowercase());
    v
}
