//! Graphics card readings and "is a game running?".
//!
//! - Usage and video memory come from Windows' own GPU performance counters
//!   (the numbers Task Manager shows), so they work for any brand.
//! - The card's name and total memory come from DXGI.
//! - On AMD cards, temperature, clocks, fan and power come from the AMD driver
//!   library (atiadlxx.dll, part of every Adrenalin install), loaded at run
//!   time. Readings outside sane ranges are dropped rather than shown.
//! - A running game is detected from Steam's RunningAppID.
//!
//! Every value is optional: BEV reports what it can actually read.

use crate::error::BevResult;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Default, Clone, Serialize)]
pub struct GpuStats {
    pub name: Option<String>,
    pub vram_total_mb: Option<u64>,
    pub vram_used_mb: Option<u64>,
    /// 3D engine use, 0-100.
    pub usage: Option<f32>,
    pub temp_c: Option<f32>,
    pub hotspot_c: Option<f32>,
    pub mem_temp_c: Option<f32>,
    pub clock_mhz: Option<u32>,
    pub mem_clock_mhz: Option<u32>,
    pub fan_rpm: Option<u32>,
    pub fan_percent: Option<u32>,
    pub power_w: Option<u32>,
}

/// Pure: GPU busy-ness from "GPU Engine" counter instances, like Task Manager:
/// per adapter, add up each engine's use across processes, take the busiest
/// engine; then the busiest adapter. Instance names look like
/// `pid_1234_luid_0x00000000_0x0000D1B5_phys_0_eng_0_engtype_3D`.
pub fn usage_from_engines(items: &[(String, f64)]) -> Option<f32> {
    let mut per: HashMap<(String, String), f64> = HashMap::new();
    for (name, v) in items {
        let luid = name.split("_luid_").nth(1).and_then(|r| r.split("_phys").next()).unwrap_or("").to_string();
        let eng = name.split("_eng_").nth(1).unwrap_or("").to_string();
        if luid.is_empty() || eng.is_empty() || !v.is_finite() {
            continue;
        }
        *per.entry((luid, eng)).or_default() += v.max(0.0);
    }
    per.values().cloned().fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v)))).map(|v| v.min(100.0) as f32)
}

/// Pure: keep an AMD sensor value only if it's believable.
pub fn sane(v: i32, lo: i32, hi: i32) -> Option<i32> {
    (v >= lo && v <= hi).then_some(v)
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::Mutex;

    // ---- Performance counters (pdh.dll), declared by hand for exact types.
    #[link(name = "pdh")]
    extern "system" {
        fn PdhOpenQueryW(src: *const u16, user: usize, query: *mut isize) -> u32;
        fn PdhAddEnglishCounterW(query: isize, path: *const u16, user: usize, counter: *mut isize) -> u32;
        fn PdhCollectQueryData(query: isize) -> u32;
        fn PdhGetFormattedCounterArrayW(counter: isize, format: u32, size: *mut u32, count: *mut u32, items: *mut u8) -> u32;
    }
    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;

    #[repr(C)]
    struct Item {
        name: *const u16,
        status: u32,
        value: f64,
    }

    struct Pdh {
        query: isize,
        engines: isize,
        memory: isize,
        primed: bool,
    }
    // The handles are only used under the mutex.
    unsafe impl Send for Pdh {}

    static PDH: Mutex<Option<Pdh>> = Mutex::new(None);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn read_array(counter: isize) -> Vec<(String, f64)> {
        unsafe {
            let (mut size, mut count) = (0u32, 0u32);
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, std::ptr::null_mut()) != PDH_MORE_DATA || size == 0 {
                return vec![];
            }
            // u64 backing keeps the buffer 8-byte aligned for the items.
            let mut buf = vec![0u64; (size as usize).div_ceil(8)];
            if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, buf.as_mut_ptr().cast()) != 0 {
                return vec![];
            }
            let items = std::slice::from_raw_parts(buf.as_ptr() as *const Item, count as usize);
            items
                .iter()
                .filter(|i| i.status == 0 && !i.name.is_null())
                .map(|i| {
                    let mut n = 0;
                    while *i.name.add(n) != 0 {
                        n += 1;
                    }
                    (String::from_utf16_lossy(std::slice::from_raw_parts(i.name, n)), i.value)
                })
                .collect()
        }
    }

    /// (usage %, dedicated memory in use, bytes). Usage needs two samples, so
    /// the first call after start-up returns None for it.
    pub fn counters() -> (Option<f32>, Option<u64>) {
        let mut g = PDH.lock().unwrap();
        if g.is_none() {
            unsafe {
                let mut q = 0isize;
                if PdhOpenQueryW(std::ptr::null(), 0, &mut q) != 0 {
                    return (None, None);
                }
                let (mut e, mut m) = (0isize, 0isize);
                let _ = PdhAddEnglishCounterW(q, wide("\\GPU Engine(*)\\Utilization Percentage").as_ptr(), 0, &mut e);
                let _ = PdhAddEnglishCounterW(q, wide("\\GPU Adapter Memory(*)\\Dedicated Usage").as_ptr(), 0, &mut m);
                *g = Some(Pdh { query: q, engines: e, memory: m, primed: false });
            }
        }
        let p = g.as_mut().unwrap();
        if unsafe { PdhCollectQueryData(p.query) } != 0 {
            return (None, None);
        }
        if !p.primed {
            p.primed = true;
            std::thread::sleep(std::time::Duration::from_millis(250));
            unsafe { PdhCollectQueryData(p.query) };
        }
        let usage = if p.engines != 0 { usage_from_engines(&read_array(p.engines)) } else { None };
        let mem = if p.memory != 0 { read_array(p.memory).into_iter().map(|(_, v)| v as u64).max() } else { None };
        (usage, mem)
    }

    /// The main graphics card: the hardware adapter with the most video memory.
    pub fn adapter() -> Option<(String, u64, u32)> {
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
        unsafe {
            let f: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let mut best: Option<(String, u64, u32)> = None;
            let mut i = 0u32;
            while let Ok(a) = f.EnumAdapters1(i) {
                i += 1;
                let Ok(d) = a.GetDesc1() else { continue };
                if (d.Flags as u32) & 2 != 0 {
                    continue; // software renderer
                }
                let len = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
                let name = String::from_utf16_lossy(&d.Description[..len]).trim().to_string();
                let mem = d.DedicatedVideoMemory as u64;
                if best.as_ref().map_or(true, |b| mem > b.1) {
                    best = Some((name, mem, d.VendorId));
                }
            }
            best
        }
    }

    // ---- AMD driver library (atiadlxx.dll), loaded at run time.
    type MallocCb = extern "C" fn(i32) -> *mut std::ffi::c_void;
    type CreateFn = unsafe extern "C" fn(MallocCb, i32, *mut *mut std::ffi::c_void) -> i32;
    type CountFn = unsafe extern "C" fn(*mut std::ffi::c_void, *mut i32) -> i32;
    type ActiveFn = unsafe extern "C" fn(*mut std::ffi::c_void, i32, *mut i32) -> i32;
    type PmLogFn = unsafe extern "C" fn(*mut std::ffi::c_void, i32, *mut PmLog) -> i32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Sensor {
        supported: i32,
        value: i32,
    }
    #[repr(C)]
    pub struct PmLog {
        size: i32,
        sensors: [Sensor; 256],
    }

    extern "C" fn adl_malloc(size: i32) -> *mut std::ffi::c_void {
        // ADL asks for memory only for calls BEV doesn't make; keep it simple.
        let v = vec![0u8; size.max(0) as usize].into_boxed_slice();
        Box::into_raw(v) as *mut std::ffi::c_void
    }

    struct Adl {
        ctx: *mut std::ffi::c_void,
        pmlog: PmLogFn,
        adapter: i32,
    }
    unsafe impl Send for Adl {}

    static ADL: Mutex<Option<Option<Adl>>> = Mutex::new(None);

    fn sym<T>(h: windows::Win32::Foundation::HMODULE, name: &str) -> Option<T> {
        use windows::Win32::System::LibraryLoader::GetProcAddress;
        let c = std::ffi::CString::new(name).ok()?;
        let p = unsafe { GetProcAddress(h, windows::core::PCSTR(c.as_ptr() as *const u8)) }?;
        Some(unsafe { std::mem::transmute_copy::<_, T>(&p) })
    }

    fn open_adl() -> Option<Adl> {
        use windows::core::w;
        use windows::Win32::System::LibraryLoader::LoadLibraryW;
        unsafe {
            let h = LoadLibraryW(w!("atiadlxx.dll")).ok()?;
            let create: CreateFn = sym(h, "ADL2_Main_Control_Create")?;
            let count: CountFn = sym(h, "ADL2_Adapter_NumberOfAdapters_Get")?;
            let active: ActiveFn = sym(h, "ADL2_Adapter_Active_Get")?;
            let pmlog: PmLogFn = sym(h, "ADL2_New_QueryPMLogData_Get")?;
            let mut ctx = std::ptr::null_mut();
            if create(adl_malloc, 1, &mut ctx) != 0 || ctx.is_null() {
                return None;
            }
            let mut n = 0;
            if count(ctx, &mut n) != 0 {
                return None;
            }
            // Several adapter indexes can point at one card (one per output):
            // use the first active one that answers with a temperature.
            for i in 0..n.clamp(0, 64) {
                let mut on = 0;
                if active(ctx, i, &mut on) != 0 || on == 0 {
                    continue;
                }
                let mut log: Box<PmLog> = Box::new(std::mem::zeroed());
                log.size = std::mem::size_of::<PmLog>() as i32;
                if pmlog(ctx, i, &mut *log) == 0 && log.sensors[8].supported != 0 {
                    return Some(Adl { ctx, pmlog, adapter: i });
                }
            }
            None
        }
    }

    pub fn amd(s: &mut GpuStats) {
        let mut g = ADL.lock().unwrap();
        if g.is_none() {
            *g = Some(open_adl());
        }
        let Some(Some(adl)) = g.as_ref() else { return };
        let mut log: Box<PmLog> = Box::new(unsafe { std::mem::zeroed() });
        log.size = std::mem::size_of::<PmLog>() as i32;
        if unsafe { (adl.pmlog)(adl.ctx, adl.adapter, &mut *log) } != 0 {
            return;
        }
        let get = |i: usize, lo: i32, hi: i32| {
            let x = log.sensors[i];
            if x.supported != 0 { sane(x.value, lo, hi) } else { None }
        };
        // Sensor numbers from AMD's adl_defines.h (ADL_PMLOG_*).
        s.clock_mhz = get(1, 1, 5000).map(|v| v as u32);
        s.mem_clock_mhz = get(2, 1, 30000).map(|v| v as u32);
        s.temp_c = get(8, 1, 125).map(|v| v as f32);
        s.mem_temp_c = get(9, 1, 125).map(|v| v as f32);
        s.fan_rpm = get(14, 0, 10000).map(|v| v as u32);
        s.fan_percent = get(15, 0, 100).map(|v| v as u32);
        s.power_w = get(23, 1, 1000).map(|v| v as u32);
        s.hotspot_c = get(27, 1, 130).map(|v| v as f32);
        if s.usage.is_none() {
            s.usage = get(19, 0, 100).map(|v| v as f32);
        }
    }

    /// Steam's id for the game it's running right now, if any.
    pub fn steam_running_app() -> Option<String> {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
        let mut v = 0u32;
        let mut size = 4u32;
        let st = unsafe {
            RegGetValueW(HKEY_CURRENT_USER, w!("Software\\Valve\\Steam"), w!("RunningAppID"), RRF_RT_REG_DWORD, None, Some((&mut v as *mut u32).cast()), Some(&mut size))
        };
        (st.is_ok() && v != 0).then(|| v.to_string())
    }
}

#[tauri::command]
pub async fn gpu_stats() -> BevResult<GpuStats> {
    tauri::async_runtime::spawn_blocking(|| {
        #[allow(unused_mut)]
        let mut s = GpuStats::default();
        #[cfg(windows)]
        {
            if let Some((name, total, vendor)) = win::adapter() {
                s.name = Some(name);
                s.vram_total_mb = (total > 0).then_some(total / 1_048_576);
                let (usage, used) = win::counters();
                s.usage = usage;
                s.vram_used_mb = used.map(|b| b / 1_048_576);
                if vendor == 0x1002 {
                    win::amd(&mut s);
                }
            }
        }
        s
    })
    .await
    .map_err(|e| crate::error::BevError::Os(e.to_string()))
}

#[derive(Serialize)]
pub struct RunningGame {
    pub id: String,
    pub name: Option<String>,
}

/// The Steam game running now, if any (full-screen detection is separate:
/// see overlay::fullscreen_state).
#[tauri::command]
pub fn running_game() -> Option<RunningGame> {
    #[cfg(windows)]
    {
        let id = win::steam_running_app()?;
        let name = crate::games::list_games().ok().and_then(|gs| gs.into_iter().find(|g| g.id == id).map(|g| g.name));
        Some(RunningGame { id, name })
    }
    #[cfg(not(windows))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_matches_task_manager_style() {
        let items = vec![
            ("pid_10_luid_0x0_0xD1B5_phys_0_eng_0_engtype_3D".to_string(), 40.0),
            ("pid_11_luid_0x0_0xD1B5_phys_0_eng_0_engtype_3D".to_string(), 25.0),
            ("pid_10_luid_0x0_0xD1B5_phys_0_eng_3_engtype_VideoDecode".to_string(), 30.0),
            ("pid_12_luid_0x0_0xAAAA_phys_0_eng_0_engtype_3D".to_string(), 10.0),
            ("garbage".to_string(), 99.0),
        ];
        assert_eq!(usage_from_engines(&items), Some(65.0));
        assert_eq!(usage_from_engines(&[("pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D".into(), 180.0)]), Some(100.0));
        assert_eq!(usage_from_engines(&[]), None);
    }

    #[test]
    fn sane_drops_nonsense() {
        assert_eq!(sane(62, 1, 125), Some(62));
        assert_eq!(sane(0, 1, 125), None);
        assert_eq!(sane(-1, 0, 100), None);
        assert_eq!(sane(65535, 1, 125), None);
    }
}
