//! PC settings BEV can change directly: dark/light mode, power plan, monitor
//! brightness (DDC/CI, for monitors that support it), media keys, wallpaper
//! and emptying the Recycle Bin. Audio devices live in audio.rs.
//!
//! Win32 entry points that aren't in the `windows` features BEV uses are
//! declared by hand with exact C types.

use crate::error::{BevError, BevResult};
use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct PowerPlan {
    pub id: String,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct MonitorBrightness {
    pub index: usize,
    pub name: String,
    pub percent: u32,
}

/// Pure: a power plan from what the user said ("performance", "battery saver").
pub fn pick_plan<'a>(plans: &'a [PowerPlan], wanted: &str) -> Option<&'a PowerPlan> {
    let w = wanted.trim().to_lowercase();
    let w = match w.as_str() {
        "performance" | "high" | "max" | "maximum" | "fast" | "gaming" => "high performance".to_string(),
        "saver" | "battery" | "battery saver" | "low" | "eco" | "power saving" => "power saver".to_string(),
        "normal" | "default" | "recommended" => "balanced".to_string(),
        _ => w,
    };
    plans
        .iter()
        .find(|p| p.name.to_lowercase() == w)
        .or_else(|| plans.iter().find(|p| p.name.to_lowercase().contains(&w)))
        .or_else(|| {
            // "ultimate" etc: any single word match
            let words: Vec<&str> = w.split_whitespace().collect();
            let hits: Vec<&PowerPlan> = plans.iter().filter(|p| words.iter().any(|x| p.name.to_lowercase().contains(x))).collect();
            (hits.len() == 1).then(|| hits[0])
        })
}

/// Pure: brightness in the monitor's own range → percent and back.
pub fn to_percent(min: u32, cur: u32, max: u32) -> u32 {
    if max <= min { return 0; }
    ((cur.saturating_sub(min)) as f64 * 100.0 / (max - min) as f64).round().min(100.0) as u32
}
pub fn from_percent(min: u32, max: u32, pct: u32) -> u32 {
    if max <= min { return min; }
    min + ((max - min) as f64 * pct.min(100) as f64 / 100.0).round() as u32
}

/// A Linux power profile, named like Windows' plans so pick_plan works.
pub fn profile(id: &str, active: bool) -> PowerPlan {
    let name = match id {
        "performance" => "High performance",
        "balanced" => "Balanced",
        "power-saver" => "Power saver",
        other => other,
    };
    PowerPlan { id: id.to_string(), name: name.to_string(), active }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Guid {
        d1: u32,
        d2: u16,
        d3: u16,
        d4: [u8; 8],
    }
    impl Guid {
        pub fn text(&self) -> String {
            format!(
                "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                self.d1, self.d2, self.d3, self.d4[0], self.d4[1], self.d4[2], self.d4[3], self.d4[4], self.d4[5], self.d4[6], self.d4[7]
            )
        }
    }

    #[link(name = "powrprof")]
    extern "system" {
        fn PowerGetActiveScheme(root: isize, active: *mut *mut Guid) -> u32;
        fn PowerSetActiveScheme(root: isize, scheme: *const Guid) -> u32;
        fn PowerEnumerate(root: isize, scheme: *const Guid, sub: *const Guid, flags: u32, index: u32, buf: *mut u8, size: *mut u32) -> u32;
        fn PowerReadFriendlyName(root: isize, scheme: *const Guid, sub: *const Guid, setting: *const Guid, buf: *mut u8, size: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(mem: *mut c_void) -> *mut c_void;
    }
    const ACCESS_SCHEME: u32 = 16;

    fn friendly(g: &Guid) -> String {
        unsafe {
            let mut size = 0u32;
            PowerReadFriendlyName(0, g, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), &mut size);
            if size == 0 {
                return g.text();
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2)];
            if PowerReadFriendlyName(0, g, std::ptr::null(), std::ptr::null(), buf.as_mut_ptr().cast(), &mut size) != 0 {
                return g.text();
            }
            let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            String::from_utf16_lossy(&buf[..n])
        }
    }

    pub fn plans() -> Vec<(Guid, PowerPlan)> {
        let mut out = Vec::new();
        unsafe {
            let mut act: *mut Guid = std::ptr::null_mut();
            let active = if PowerGetActiveScheme(0, &mut act) == 0 && !act.is_null() {
                let a = (*act).text();
                LocalFree(act.cast());
                Some(a)
            } else {
                None
            };
            for i in 0..32u32 {
                let mut g: Guid = std::mem::zeroed();
                let mut size = std::mem::size_of::<Guid>() as u32;
                if PowerEnumerate(0, std::ptr::null(), std::ptr::null(), ACCESS_SCHEME, i, (&mut g as *mut Guid).cast(), &mut size) != 0 {
                    break;
                }
                let id = g.text();
                out.push((g, PowerPlan { active: active.as_deref() == Some(id.as_str()), name: friendly(&g), id }));
            }
        }
        out
    }

    pub fn set_plan(g: &Guid) -> bool {
        unsafe { PowerSetActiveScheme(0, g) == 0 }
    }

    // ---- Monitor brightness over DDC/CI (dxva2.dll)
    #[repr(C)]
    struct Physical {
        handle: isize,
        desc: [u16; 128],
    }
    #[repr(C)]
    struct Rect {
        l: i32,
        t: i32,
        r: i32,
        b: i32,
    }
    #[link(name = "dxva2")]
    extern "system" {
        fn GetNumberOfPhysicalMonitorsFromHMONITOR(mon: isize, n: *mut u32) -> i32;
        fn GetPhysicalMonitorsFromHMONITOR(mon: isize, n: u32, out: *mut Physical) -> i32;
        fn GetMonitorBrightness(h: isize, min: *mut u32, cur: *mut u32, max: *mut u32) -> i32;
        fn SetMonitorBrightness(h: isize, v: u32) -> i32;
        fn DestroyPhysicalMonitors(n: u32, arr: *const Physical) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn EnumDisplayMonitors(hdc: isize, clip: *const Rect, cb: extern "system" fn(isize, isize, *mut Rect, isize) -> i32, data: isize) -> i32;
    }

    extern "system" fn collect(mon: isize, _: isize, _: *mut Rect, data: isize) -> i32 {
        let v = unsafe { &mut *(data as *mut Vec<isize>) };
        v.push(mon);
        1
    }

    /// Run `f` on every physical monitor: (index, name, handle).
    pub fn with_monitors<T>(mut f: impl FnMut(usize, String, isize) -> Option<T>) -> Vec<T> {
        let mut mons: Vec<isize> = Vec::new();
        unsafe { EnumDisplayMonitors(0, std::ptr::null(), collect, &mut mons as *mut Vec<isize> as isize) };
        let mut out = Vec::new();
        let mut idx = 0;
        for m in mons {
            unsafe {
                let mut n = 0u32;
                if GetNumberOfPhysicalMonitorsFromHMONITOR(m, &mut n) == 0 || n == 0 || n > 8 {
                    idx += 1;
                    continue;
                }
                let mut arr: Vec<Physical> = (0..n).map(|_| Physical { handle: 0, desc: [0; 128] }).collect();
                if GetPhysicalMonitorsFromHMONITOR(m, n, arr.as_mut_ptr()) != 0 {
                    for p in &arr {
                        let len = p.desc.iter().position(|&c| c == 0).unwrap_or(128);
                        let name = String::from_utf16_lossy(&p.desc[..len]);
                        if let Some(t) = f(idx, name, p.handle) {
                            out.push(t);
                        }
                        idx += 1;
                    }
                    DestroyPhysicalMonitors(n, arr.as_ptr());
                } else {
                    idx += 1;
                }
            }
        }
        out
    }

    pub fn get_brightness(h: isize) -> Option<(u32, u32, u32)> {
        let (mut a, mut b, mut c) = (0u32, 0u32, 0u32);
        (unsafe { GetMonitorBrightness(h, &mut a, &mut b, &mut c) } != 0).then_some((a, b, c))
    }
    pub fn set_brightness(h: isize, v: u32) -> bool {
        unsafe { SetMonitorBrightness(h, v) != 0 }
    }
}

#[tauri::command]
pub fn power_plans() -> BevResult<Vec<PowerPlan>> {
    #[cfg(windows)]
    {
        Ok(win::plans().into_iter().map(|p| p.1).collect())
    }
    #[cfg(target_os = "linux")]
    {
        let (ids, active) = crate::kwin::power_profiles().map_err(BevError::Unsupported)?;
        Ok(ids.into_iter().map(|id| profile(&id, id == active)).collect())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    Err(BevError::Unsupported("power plans aren't supported on this OS".into()))
}

#[tauri::command]
pub fn set_power_plan(name: String) -> BevResult<String> {
    #[cfg(windows)]
    {
        let all = win::plans();
        let list: Vec<PowerPlan> = all.iter().map(|p| p.1.clone()).collect();
        let Some(p) = pick_plan(&list, &name) else {
            return Err(BevError::NotFound(format!("no power plan called \"{name}\"; this PC has: {}", list.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "))));
        };
        let g = all.iter().find(|x| x.1.id == p.id).map(|x| x.0).unwrap();
        if !win::set_plan(&g) {
            return Err(BevError::Os("Windows didn't accept the change".into()));
        }
        Ok(format!("power plan set to {}", p.name))
    }
    #[cfg(target_os = "linux")]
    {
        let list = power_plans()?;
        let Some(p) = pick_plan(&list, &name) else {
            return Err(BevError::NotFound(format!("no power profile called \"{name}\"; this PC has: {}", list.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", "))));
        };
        crate::kwin::set_power_profile(&p.id).map_err(BevError::Os)?;
        Ok(format!("power profile set to {}", p.name))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = name;
        Err(BevError::Unsupported("power plans aren't supported on this OS".into()))
    }
}

#[tauri::command]
pub async fn monitor_brightness() -> BevResult<Vec<MonitorBrightness>> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            win::with_monitors(|index, name, h| win::get_brightness(h).map(|(a, b, c)| MonitorBrightness { index, name: if name.trim().is_empty() { format!("Monitor {}", index + 1) } else { name }, percent: to_percent(a, b, c) }))
        })
        .await
        .map_err(|e| BevError::Os(e.to_string()))
    }
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            crate::kwin::displays().map_err(BevError::Unsupported).map(|ds| {
                ds.into_iter()
                    .enumerate()
                    .map(|(index, d)| MonitorBrightness { index, name: d.label, percent: to_percent(0, d.brightness.max(0) as u32, d.max.max(0) as u32) })
                    .collect()
            })
        })
        .await
        .map_err(|e| BevError::Os(e.to_string()))?
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    Err(BevError::Unsupported("brightness isn't supported on this OS".into()))
}

/// Set brightness on one monitor (index) or all that support it.
#[tauri::command]
pub async fn set_monitor_brightness(percent: u32, index: Option<usize>) -> BevResult<String> {
    #[cfg(windows)]
    {
        let changed = tauri::async_runtime::spawn_blocking(move || {
            win::with_monitors(|i, _, h| {
                if index.is_some_and(|w| w != i) {
                    return None;
                }
                let (a, _, c) = win::get_brightness(h)?;
                win::set_brightness(h, from_percent(a, c, percent)).then_some(i)
            })
        })
        .await
        .map_err(|e| BevError::Os(e.to_string()))?;
        if changed.is_empty() {
            return Err(BevError::Unsupported("no monitor accepted a brightness change. Many monitors need DDC/CI switched on in their own menu; laptop screens aren't supported yet".into()));
        }
        Ok(format!("brightness set to {}% on {} monitor{}", percent.min(100), changed.len(), if changed.len() == 1 { "" } else { "s" }))
    }
    #[cfg(target_os = "linux")]
    {
        let changed = tauri::async_runtime::spawn_blocking(move || -> BevResult<usize> {
            let ds = crate::kwin::displays().map_err(BevError::Unsupported)?;
            let mut n = 0;
            for (i, d) in ds.iter().enumerate() {
                if index.is_some_and(|w| w != i) || d.max <= 0 {
                    continue;
                }
                if crate::kwin::set_display_brightness(&d.path, from_percent(0, d.max as u32, percent) as i32).is_ok() {
                    n += 1;
                }
            }
            Ok(n)
        })
        .await
        .map_err(|e| BevError::Os(e.to_string()))??;
        if changed == 0 {
            return Err(BevError::Unsupported("no screen accepted a brightness change. External monitors need DDC/CI on in their own menu, and Plasma needs ddcutil access".into()));
        }
        Ok(format!("brightness set to {}% on {} screen{}", percent.min(100), changed, if changed == 1 { "" } else { "s" }))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (percent, index);
        Err(BevError::Unsupported("brightness isn't supported on this OS".into()))
    }
}

/// Dark or light mode for Windows and apps.
#[tauri::command]
pub fn set_theme(dark: bool) -> BevResult<String> {
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD};
        use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let v: u32 = if dark { 0 } else { 1 };
        let key = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize");
        for name in [w!("AppsUseLightTheme"), w!("SystemUsesLightTheme")] {
            let st = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key, name, REG_DWORD.0, Some((&v as *const u32).cast()), 4) };
            if st.is_err() {
                return Err(BevError::Os("couldn't change the theme setting".into()));
            }
        }
        let topic = w!("ImmersiveColorSet");
        unsafe { SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(topic.as_ptr() as isize), SMTO_ABORTIFHUNG, 1000, None) };
        Ok(if dark { "dark mode on".into() } else { "light mode on".into() })
    }
    #[cfg(target_os = "linux")]
    {
        let scheme = if dark { "BreezeDark" } else { "BreezeLight" };
        crate::linux::run("plasma-apply-colorscheme", &[scheme])?;
        Ok(if dark { "dark mode on".into() } else { "light mode on".into() })
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = dark;
        Err(BevError::Unsupported("themes aren't supported on this OS".into()))
    }
}

/// Media keys, sent globally (they work over full-screen games too).
#[tauri::command]
pub fn media_key(action: String) -> BevResult<String> {
    let vk: u16 = match action.as_str() {
        "play_pause" => 0xB3,
        "next" => 0xB0,
        "previous" => 0xB1,
        "stop" => 0xB2,
        _ => return Err(BevError::Invalid("action must be play_pause, next, previous or stop".into())),
    };
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY};
        let mk = |flags| INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
        let inputs = [mk(KEYEVENTF_EXTENDEDKEY), mk(KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP)];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent != 2 {
            return Err(BevError::Os("Windows blocked the key press".into()));
        }
        Ok(format!("pressed {}", action.replace('_', "/")))
    }
    #[cfg(target_os = "linux")]
    {
        let method = match action.as_str() {
            "play_pause" => "PlayPause",
            "next" => "Next",
            "previous" => "Previous",
            _ => "Stop",
        };
        match crate::kwin::mpris(method) {
            Ok(player) => Ok(format!("{} on {player}", action.replace('_', "/"))),
            // No MPRIS player: fall back to pressing the media key.
            Err(_) => {
                let combo = crate::control::keys::Combo { mods: vec![], key: Some(vk), text: action.clone() };
                crate::control::input::press(&[combo]).map_err(BevError::Os)?;
                Ok(format!("pressed {}", action.replace('_', "/")))
            }
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = vk;
        Err(BevError::Unsupported("media keys aren't supported on this OS".into()))
    }
}

#[tauri::command]
pub fn set_wallpaper(path: String) -> BevResult<String> {
    let p = crate::files::resolve(&path)?;
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "bmp") {
        return Err(BevError::Invalid("the wallpaper must be a .jpg, .png or .bmp picture".into()));
    }
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER};
        let mut wide: Vec<u16> = p.display().to_string().encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, Some(wide.as_mut_ptr().cast()), SPIF_UPDATEINIFILE | SPIF_SENDCHANGE) }.map_err(|e| BevError::Os(format!("couldn't set the wallpaper: {e}")))?;
        Ok(format!("wallpaper set to {}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
    }
    #[cfg(target_os = "linux")]
    {
        crate::linux::run("plasma-apply-wallpaperimage", &[&p.to_string_lossy()])?;
        Ok(format!("wallpaper set to {}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    Err(BevError::Unsupported("wallpaper isn't supported on this OS".into()))
}

#[tauri::command]
pub fn empty_recycle_bin() -> BevResult<String> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND};
        unsafe { SHEmptyRecycleBinW(windows::Win32::Foundation::HWND::default(), windows::core::PCWSTR::null(), SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND) }.or_else(|e| {
            // Already empty reports an error on some versions; treat as done.
            if e.code().0 as u32 == 0x8000_FFFF { Ok(()) } else { Err(BevError::Os(format!("couldn't empty the Recycle Bin: {e}"))) }
        })?;
        Ok("Recycle Bin emptied".into())
    }
    #[cfg(target_os = "linux")]
    {
        crate::linux::run("gio", &["trash", "--empty"])?;
        Ok("Trash emptied".into())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    Err(BevError::Unsupported("the Recycle Bin isn't supported on this OS".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(name: &str) -> PowerPlan {
        PowerPlan { id: name.into(), name: name.into(), active: false }
    }

    #[test]
    fn reads_linux_power_profiles() {
        let ps: Vec<PowerPlan> = [("performance", false), ("balanced", true), ("power-saver", false)].iter().map(|(i, a)| profile(i, *a)).collect();
        assert_eq!(ps.len(), 3);
        assert!(ps[1].active && ps[1].name == "Balanced");
        assert_eq!(pick_plan(&ps, "gaming").unwrap().id, "performance");
    }

    #[test]
    fn picks_plans_from_everyday_words() {
        let ps = vec![plan("Balanced"), plan("High performance"), plan("Power saver"), plan("AMD Ryzen Balanced")];
        assert_eq!(pick_plan(&ps, "performance").unwrap().name, "High performance");
        assert_eq!(pick_plan(&ps, "battery saver").unwrap().name, "Power saver");
        assert_eq!(pick_plan(&ps, "normal").unwrap().name, "Balanced");
        assert_eq!(pick_plan(&ps, "ryzen").unwrap().name, "AMD Ryzen Balanced");
        assert!(pick_plan(&ps, "ultimate").is_none());
    }

    #[test]
    fn brightness_scaling() {
        assert_eq!(to_percent(0, 50, 100), 50);
        assert_eq!(to_percent(10, 60, 110), 50);
        assert_eq!(from_percent(0, 100, 30), 30);
        assert_eq!(from_percent(10, 110, 150), 110);
        assert_eq!(to_percent(5, 5, 5), 0);
    }
}
