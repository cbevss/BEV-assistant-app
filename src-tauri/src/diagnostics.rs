//! Read-only health checks for troubleshooting. Each command gathers facts;
//! the app turns them into findings (src/lib/diagnose.ts). Nothing here
//! changes the system, and the one PowerShell script is fixed text that takes
//! no input from the AI.

use crate::{error::BevResult, AppState};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use sysinfo::ProcessRefreshKind;
use tauri::State;

#[derive(Serialize)]
pub struct DiskFacts {
    pub mount: String,
    pub total_gb: f64,
    pub free_gb: f64,
}

#[derive(Serialize)]
pub struct ProcFacts {
    pub name: String,
    pub cpu: f32,
    pub mem_mb: u64,
}

#[derive(Serialize)]
pub struct SystemFacts {
    pub cpu: f32,
    pub cores: usize,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub uptime_secs: u64,
    pub disks: Vec<DiskFacts>,
    pub top_cpu: Vec<ProcFacts>,
    pub top_mem: Vec<ProcFacts>,
    pub pending_reboot: bool,
}

const GB: f64 = 1_073_741_824.0;

#[tauri::command]
pub async fn diag_system(state: State<'_, AppState>) -> BevResult<SystemFacts> {
    // CPU figures need two samples a moment apart.
    {
        let mut sys = state.sys.lock().unwrap();
        sys.refresh_cpu_usage();
        sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_cpu().with_memory());
    }
    tokio_sleep(Duration::from_millis(700)).await;
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, ProcessRefreshKind::new().with_cpu().with_memory());
    let cores = sys.cpus().len().max(1);
    let cpu = sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / cores as f32;

    // Group processes by name (browsers run dozens).
    let mut by_name: std::collections::HashMap<String, (f32, u64)> = std::collections::HashMap::new();
    for p in sys.processes().values() {
        let e = by_name.entry(p.name().to_string_lossy().into_owned()).or_default();
        e.0 += p.cpu_usage() / cores as f32;
        e.1 += p.memory() / 1_048_576;
    }
    let mut procs: Vec<ProcFacts> = by_name.into_iter().filter(|(n, _)| n != "System Idle Process").map(|(name, (cpu, mem_mb))| ProcFacts { name, cpu, mem_mb }).collect();
    procs.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    let top_cpu: Vec<ProcFacts> = procs.iter().take(5).map(|p| ProcFacts { name: p.name.clone(), cpu: p.cpu, mem_mb: p.mem_mb }).collect();
    procs.sort_by(|a, b| b.mem_mb.cmp(&a.mem_mb));
    let top_mem: Vec<ProcFacts> = procs.into_iter().take(5).collect();

    let disks = sysinfo::Disks::new_with_refreshed_list()
        .list()
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| DiskFacts { mount: d.mount_point().to_string_lossy().into_owned(), total_gb: d.total_space() as f64 / GB, free_gb: d.available_space() as f64 / GB })
        .collect();

    Ok(SystemFacts {
        cpu,
        cores,
        mem_used_mb: sys.used_memory() / 1_048_576,
        mem_total_mb: sys.total_memory() / 1_048_576,
        uptime_secs: sysinfo::System::uptime(),
        disks,
        top_cpu,
        top_mem,
        pending_reboot: pending_reboot(),
    })
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[cfg(windows)]
fn pending_reboot() -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ};
    const KEYS: &[&str] = &[
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
    ];
    KEYS.iter().any(|k| unsafe {
        let mut h = HKEY::default();
        let ok = RegOpenKeyExW(HKEY_LOCAL_MACHINE, &HSTRING::from(*k), 0, KEY_READ, &mut h) == ERROR_SUCCESS;
        if ok {
            let _ = RegCloseKey(h);
        }
        ok
    })
}

#[cfg(not(windows))]
fn pending_reboot() -> bool {
    false
}

#[derive(Serialize)]
pub struct Probe {
    pub ok: bool,
    pub ms: Option<u64>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct NetworkFacts {
    /// Name lookup (DNS).
    pub dns: Probe,
    /// Direct connections to well-known addresses (no DNS involved).
    pub direct: Vec<(String, Probe)>,
    /// A full HTTPS-port connection to a named host.
    pub named: Probe,
}

fn probe(f: impl FnOnce() -> std::io::Result<()>) -> Probe {
    let t = Instant::now();
    match f() {
        Ok(()) => Probe { ok: true, ms: Some(t.elapsed().as_millis() as u64), error: None },
        Err(e) => Probe { ok: false, ms: None, error: Some(e.to_string()) },
    }
}

#[tauri::command]
pub async fn diag_network() -> BevResult<NetworkFacts> {
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
    let r = tauri::async_runtime::spawn_blocking(|| {
        let timeout = Duration::from_secs(3);
        let dns = probe(|| ("www.msftconnecttest.com", 80).to_socket_addrs().map(|_| ()));
        let direct = ["1.1.1.1:443", "8.8.8.8:443"]
            .iter()
            .map(|a| {
                let addr: SocketAddr = a.parse().expect("valid address");
                (a.to_string(), probe(|| TcpStream::connect_timeout(&addr, timeout).map(|_| ())))
            })
            .collect();
        let named = probe(|| {
            let addr = ("www.microsoft.com", 443).to_socket_addrs()?.next().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no address"))?;
            TcpStream::connect_timeout(&addr, timeout).map(|_| ())
        });
        NetworkFacts { dns, direct, named }
    })
    .await
    .map_err(|e| crate::error::BevError::Os(format!("task: {e}")))?;
    Ok(r)
}

#[derive(Serialize, Deserialize, Default)]
pub struct EventFacts {
    #[serde(default)]
    pub app: Vec<AppEvent>,
    #[serde(default)]
    pub system: Vec<SysEvent>,
}

#[derive(Serialize, Deserialize)]
pub struct AppEvent {
    pub t: String,
    pub kind: String,
    #[serde(default)]
    pub app: String,
}

#[derive(Serialize, Deserialize)]
pub struct SysEvent {
    pub t: String,
    pub id: u32,
    #[serde(default)]
    pub provider: String,
}

/// App crashes/hangs, unexpected shutdowns and blue screens in the last __MINUTES__ minutes
/// (the number is filled in by BEV; nothing else in the script varies).
const EVENTS_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$since = (Get-Date).AddMinutes(-__MINUTES__)
$app = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error','Application Hang'; StartTime=$since} -MaxEvents 200 |
  ForEach-Object { [pscustomobject]@{ t = $_.TimeCreated.ToString('o'); kind = $(if ($_.Id -eq 1002) { 'hang' } else { 'crash' }); app = [string]$_.Properties[0].Value } }
$sys = Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,6008,1001; StartTime=$since} -MaxEvents 50 |
  Where-Object { $_.Id -ne 1001 -or $_.ProviderName -like '*WER-SystemErrorReporting*' } |
  ForEach-Object { [pscustomobject]@{ t = $_.TimeCreated.ToString('o'); id = $_.Id; provider = $_.ProviderName } }
[pscustomobject]@{ app = @($app); system = @($sys) } | ConvertTo-Json -Depth 4 -Compress
"#;

pub fn parse_events(stdout: &str) -> EventFacts {
    let s = stdout.trim_start_matches('\u{feff}');
    s.find('{').and_then(|i| serde_json::from_str(&s[i..]).ok()).unwrap_or_default()
}

#[tauri::command]
pub async fn diag_events(app: tauri::AppHandle, minutes: Option<u32>) -> BevResult<EventFacts> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().map_err(|e| crate::error::BevError::Os(e.to_string()))?;
    // Default: the last week. The value is a plain integer, so the script stays fixed text.
    let mins = minutes.unwrap_or(7 * 24 * 60).clamp(1, 30 * 24 * 60);
    let script = EVENTS_SCRIPT.replace("__MINUTES__", &mins.to_string());
    tauri::async_runtime::spawn_blocking(move || run_script(&dir, "diag-events.ps1", &script).map(|o| parse_events(&o)))
        .await
        .map_err(|e| crate::error::BevError::Os(format!("task: {e}")))?
        .map_err(crate::error::BevError::Os)
}

#[cfg(windows)]
fn run_script(dir: &std::path::Path, name: &str, script: &str) -> Result<String, String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    std::fs::write(&path, format!("\u{feff}{script}")).map_err(|e| e.to_string())?;
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("couldn't start PowerShell: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return Err("reading the event log took too long".into());
            }
        }
    }
    Ok(String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned())
}

#[cfg(not(windows))]
fn run_script(_d: &std::path::Path, _n: &str, _s: &str) -> Result<String, String> {
    Ok("{}".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_event_json() {
        let out = "\u{feff}{\"app\":[{\"t\":\"2026-11-16T10:00:00\",\"kind\":\"crash\",\"app\":\"game.exe\"}],\"system\":[{\"t\":\"2026-11-15T09:00:00\",\"id\":41,\"provider\":\"Microsoft-Windows-Kernel-Power\"}]}";
        let e = parse_events(out);
        assert_eq!(e.app.len(), 1);
        assert_eq!(e.app[0].app, "game.exe");
        assert_eq!(e.system[0].id, 41);
    }

    #[test]
    fn tolerates_empty_or_garbage() {
        assert!(parse_events("").app.is_empty());
        assert!(parse_events("WARNING: something").system.is_empty());
        // PowerShell turns a single-item array into an object only without @(); ours always uses @().
        assert!(parse_events("{\"app\":[],\"system\":[]}").app.is_empty());
    }
}
