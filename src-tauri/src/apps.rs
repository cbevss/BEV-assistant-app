//! Process listing. Opening and closing apps lives in the app engine
//! (appengine/), which resolves installed apps and verifies outcomes.

use crate::error::BevResult;
use serde::Serialize;

#[derive(Serialize)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
}

#[tauri::command]
pub fn list_processes(state: tauri::State<crate::AppState>) -> BevResult<Vec<ProcInfo>> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut v: Vec<ProcInfo> = sys
        .processes()
        .values()
        .map(|p| ProcInfo {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().into_owned(),
        })
        .collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v.dedup_by(|a, b| a.name == b.name);
    Ok(v)
}
