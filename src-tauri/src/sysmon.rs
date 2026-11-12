//! Real system telemetry via `sysinfo`. Values are live readings — never
//! placeholders. GPU usage is marked unavailable where no vendor API is wired.

use crate::{error::BevResult, AppState};
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, RefreshKind};
use tauri::State;

#[derive(Serialize)]
pub struct SystemStats {
    pub cpu_usage: f32,        // 0..100, averaged across cores
    pub cpu_cores: usize,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub mem_percent: f32,
    pub gpu_usage: Option<f32>, // None until a vendor sensor bridge is configured
    pub gpu_name: Option<String>,
    pub uptime_secs: u64,
    pub host: Option<String>,
}

#[tauri::command]
pub fn get_system_stats(state: State<AppState>) -> BevResult<SystemStats> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpu_usage = if sys.cpus().is_empty() {
        0.0
    } else {
        sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / sys.cpus().len() as f32
    };

    let mem_total = sys.total_memory();
    let mem_used = sys.used_memory();
    let mem_percent = if mem_total == 0 {
        0.0
    } else {
        (mem_used as f64 / mem_total as f64 * 100.0) as f32
    };

    Ok(SystemStats {
        cpu_usage,
        cpu_cores: sys.cpus().len(),
        mem_used_mb: mem_used / 1_048_576,
        mem_total_mb: mem_total / 1_048_576,
        mem_percent,
        // GPU telemetry needs an AMD ADLX / nvml bridge. Honest None until wired.
        gpu_usage: None,
        gpu_name: gpu_name_guess(),
        uptime_secs: sysinfo::System::uptime(),
        host: sysinfo::System::host_name(),
    })
}

#[derive(Serialize)]
pub struct RunningApp {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub mem_mb: u64,
}

/// Top foreground-ish processes by memory — used for the dashboard "active apps".
#[tauri::command]
pub fn get_running_apps(state: State<AppState>, limit: Option<usize>) -> BevResult<Vec<RunningApp>> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cpu().with_memory(),
    );

    let mut apps: Vec<RunningApp> = sys
        .processes()
        .values()
        .filter(|p| p.memory() > 0)
        .map(|p| RunningApp {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            cpu: p.cpu_usage(),
            mem_mb: p.memory() / 1_048_576,
        })
        .collect();

    apps.sort_by(|a, b| b.mem_mb.cmp(&a.mem_mb));
    apps.truncate(limit.unwrap_or(12));
    Ok(apps)
}

fn gpu_name_guess() -> Option<String> {
    // sysinfo has no GPU API; name is reported only when an external bridge
    // populates it. Returns None rather than guessing a model string.
    let _ = RefreshKind::new();
    None
}
