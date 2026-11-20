//! System volume + mute and output-device selection via the Windows Core Audio
//! API. All calls fail closed with a readable error if COM is unavailable.

use crate::error::{BevError, BevResult};
use serde::Serialize;

/// One active playback endpoint (speakers, headset, monitor audio…).
#[derive(Debug, Serialize)]
pub struct OutputDevice {
    /// Opaque Windows endpoint id; pass back to `set_output_device`.
    pub id: String,
    pub name: String,
    /// True for the endpoint Windows currently plays to.
    pub is_default: bool,
}

/// One active recording endpoint, with the state Windows reports for it.
#[derive(Debug, Serialize)]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    /// The microphone Windows (and its speech recognition) records from.
    pub is_default: bool,
    /// Muted in Windows' sound settings.
    pub muted: Option<bool>,
    /// Windows input level, 0..1.
    pub volume: Option<f32>,
}

/// One app currently holding an audio session on the default speakers.
#[derive(Debug, Serialize, Clone)]
pub struct AppAudio {
    /// Executable name without ".exe", e.g. "Spotify". "System sounds" for pid 0.
    pub app: String,
    pub pid: u32,
    /// 0..100, the app's own slider in the Windows volume mixer.
    pub volume: f32,
    pub muted: bool,
}

/// Lower-case, ".exe"-less, letters-and-digits form used to match a spoken app name.
pub fn app_key(name: &str) -> String {
    let n = name.trim().to_lowercase();
    let n = n.strip_suffix(".exe").unwrap_or(&n);
    n.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Does a session's app name match what the user asked for? Either side may
/// contain the other ("discord" ~ "DiscordPTB"), but a short session name
/// only matches inside a longer request when it's at least 4 characters.
pub fn app_matches(session: &str, wanted: &str) -> bool {
    let (a, b) = (app_key(session), app_key(wanted));
    !a.is_empty() && !b.is_empty() && (a == b || a.contains(&b) || (a.len() >= 4 && b.contains(&a)))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use windows::core::{Interface, IUnknown, GUID, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, DEVICE_STATE_ACTIVE, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2,
        ISimpleAudioVolume,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        COINIT_MULTITHREADED, STGM_READ,
    };

    /// Makes sure COM is usable on the calling thread for the guard's lifetime.
    ///
    /// Tauri runs synchronous commands on the main UI thread, where the window
    /// system has already initialised COM as single-threaded (STA). Asking for
    /// multithreaded mode there fails with RPC_E_CHANGED_MODE, but COM is
    /// already up, which is all these calls need. In that case the guard must
    /// not call CoUninitialize, because it didn't add an initialisation.
    struct ComGuard {
        owns: bool,
    }
    impl ComGuard {
        fn new() -> BevResult<Self> {
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr == RPC_E_CHANGED_MODE {
                return Ok(ComGuard { owns: false });
            }
            // S_OK and S_FALSE both add a reference that must be balanced.
            hr.ok()
                .map_err(|e| BevError::Os(format!("CoInitializeEx: {e}")))?;
            Ok(ComGuard { owns: true })
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owns {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn endpoint() -> BevResult<IAudioEndpointVolume> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| BevError::Os(format!("device enumerator: {e}")))?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .map_err(|e| BevError::Os(format!("default endpoint: {e}")))?;
            let vol: IAudioEndpointVolume = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| BevError::Os(format!("activate endpoint volume: {e}")))?;
            Ok(vol.cast().unwrap_or(vol))
        }
    }

    fn enumerator() -> BevResult<IMMDeviceEnumerator> {
        unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| BevError::Os(format!("device enumerator: {e}")))
        }
    }

    /// Read an endpoint's id, freeing the COM-allocated string.
    fn device_id(device: &IMMDevice) -> BevResult<String> {
        unsafe {
            let raw: PWSTR = device
                .GetId()
                .map_err(|e| BevError::Os(format!("device id: {e}")))?;
            let id = raw.to_string();
            CoTaskMemFree(Some(raw.0 as *const c_void));
            id.map_err(|e| BevError::Os(format!("device id: {e}")))
        }
    }

    fn device_name(device: &IMMDevice) -> Option<String> {
        unsafe {
            let store = device.OpenPropertyStore(STGM_READ).ok()?;
            let value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
            let name = value.to_string();
            (!name.trim().is_empty()).then_some(name)
        }
    }

    pub fn list_outputs() -> BevResult<Vec<OutputDevice>> {
        let _g = ComGuard::new()?;
        let enumerator = enumerator()?;
        unsafe {
            // No default endpoint (e.g. nothing plugged in) is not an error here.
            let default_id = enumerator
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .ok()
                .and_then(|d| device_id(&d).ok());

            let devices = enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|e| BevError::Os(format!("enumerate outputs: {e}")))?;
            let count = devices
                .GetCount()
                .map_err(|e| BevError::Os(format!("count outputs: {e}")))?;

            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let Ok(device) = devices.Item(i) else { continue };
                let Ok(id) = device_id(&device) else { continue };
                let name = device_name(&device).unwrap_or_else(|| format!("Output {}", i + 1));
                let is_default = default_id.as_deref() == Some(id.as_str());
                out.push(OutputDevice { id, name, is_default });
            }
            Ok(out)
        }
    }

    // Windows has no documented API for changing the default endpoint. Every
    // audio switcher (including the Settings app) goes through the shell's
    // IPolicyConfig COM interface, stable since Windows 7. Only one method is
    // needed, so it is called straight off the vtable instead of declaring the
    // whole interface.
    const CLSID_POLICY_CONFIG_CLIENT: GUID =
        GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const IID_IPOLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
    /// IUnknown (3 slots) + the 10 IPolicyConfig methods before SetDefaultEndpoint.
    const SET_DEFAULT_ENDPOINT_SLOT: usize = 13;
    type SetDefaultEndpointFn =
        unsafe extern "system" fn(this: *mut c_void, device_id: PCWSTR, role: ERole) -> HRESULT;

    pub fn set_output(id: &str) -> BevResult<()> {
        set_default(eRender, id)
    }

    /// Active endpoint with this id in this direction, if it still exists.
    fn find(flow: EDataFlow, id: &str) -> BevResult<IMMDevice> {
        let enumerator = enumerator()?;
        unsafe {
            let known = enumerator
                .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                .map_err(|e| BevError::Os(format!("enumerate devices: {e}")))?;
            let count = known.GetCount().map_err(|e| BevError::Os(format!("count devices: {e}")))?;
            (0..count)
                .filter_map(|i| known.Item(i).ok())
                .find(|d| device_id(d).map(|d| d == id).unwrap_or(false))
                .ok_or_else(|| BevError::NotFound("that audio device is no longer available".into()))
        }
    }

    fn set_default(flow: EDataFlow, id: &str) -> BevResult<()> {
        let _g = ComGuard::new()?;
        // Only accept an id that is a currently active endpoint in this direction.
        find(flow, id)?;
        let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {

            let unknown: IUnknown = CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL)
                .map_err(|e| BevError::Os(format!("policy config: {e}")))?;
            let mut raw: *mut c_void = std::ptr::null_mut();
            unknown
                .query(&IID_IPOLICY_CONFIG, &mut raw)
                .ok()
                .map_err(|e| BevError::Os(format!("policy config interface: {e}")))?;
            if raw.is_null() {
                return Err(BevError::Os("policy config interface unavailable".into()));
            }
            // Takes ownership of the reference QueryInterface added; released on drop.
            let policy = IUnknown::from_raw(raw);

            let vtable = *(policy.as_raw() as *const *const *const c_void);
            let set_default: SetDefaultEndpointFn =
                std::mem::transmute(*vtable.add(SET_DEFAULT_ENDPOINT_SLOT));

            // Move every role so games, media and calls all follow the choice.
            for role in [eConsole, eMultimedia, eCommunications] {
                set_default(policy.as_raw(), PCWSTR(wide.as_ptr()), role)
                    .ok()
                    .map_err(|e| BevError::Os(format!("set default device: {e}")))?;
            }
        }
        Ok(())
    }

    pub fn list_inputs() -> BevResult<Vec<InputDevice>> {
        let _g = ComGuard::new()?;
        let enumerator = enumerator()?;
        unsafe {
            let default_id = enumerator
                .GetDefaultAudioEndpoint(eCapture, eConsole)
                .ok()
                .and_then(|d| device_id(&d).ok());
            let devices = enumerator
                .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
                .map_err(|e| BevError::Os(format!("enumerate microphones: {e}")))?;
            let count = devices.GetCount().map_err(|e| BevError::Os(format!("count microphones: {e}")))?;
            let mut out = Vec::with_capacity(count as usize);
            for i in 0..count {
                let Ok(device) = devices.Item(i) else { continue };
                let Ok(id) = device_id(&device) else { continue };
                let name = device_name(&device).unwrap_or_else(|| format!("Microphone {}", i + 1));
                let vol: Option<IAudioEndpointVolume> = device.Activate(CLSCTX_ALL, None).ok();
                let muted = vol.as_ref().and_then(|v| v.GetMute().ok()).map(|b| b.as_bool());
                let volume = vol.as_ref().and_then(|v| v.GetMasterVolumeLevelScalar().ok());
                let is_default = default_id.as_deref() == Some(id.as_str());
                out.push(InputDevice { id, name, is_default, muted, volume });
            }
            Ok(out)
        }
    }

    pub fn set_default_input(id: &str) -> BevResult<()> {
        set_default(eCapture, id)
    }

    /// Windows input level (0..1) and/or mute for one microphone.
    pub fn set_input_level(id: &str, volume: Option<f32>, muted: Option<bool>) -> BevResult<()> {
        let _g = ComGuard::new()?;
        let device = find(eCapture, id)?;
        unsafe {
            let ep: IAudioEndpointVolume =
                device.Activate(CLSCTX_ALL, None).map_err(|e| BevError::Os(format!("microphone level: {e}")))?;
            if let Some(v) = volume {
                ep.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), std::ptr::null())
                    .map_err(|e| BevError::Os(format!("set microphone level: {e}")))?;
            }
            if let Some(m) = muted {
                ep.SetMute(m, std::ptr::null()).map_err(|e| BevError::Os(format!("mute microphone: {e}")))?;
            }
        }
        Ok(())
    }

    pub fn get() -> BevResult<f32> {
        let _g = ComGuard::new()?;
        let ep = endpoint()?;
        unsafe {
            let level = ep
                .GetMasterVolumeLevelScalar()
                .map_err(|e| BevError::Os(format!("get volume: {e}")))?;
            Ok((level * 100.0).round())
        }
    }

    pub fn set(percent: f32) -> BevResult<()> {
        if !(0.0..=100.0).contains(&percent) {
            return Err(BevError::Invalid("volume must be 0..100".into()));
        }
        let _g = ComGuard::new()?;
        let ep = endpoint()?;
        unsafe {
            ep.SetMasterVolumeLevelScalar(percent / 100.0, std::ptr::null())
                .map_err(|e| BevError::Os(format!("set volume: {e}")))
        }
    }

    pub fn set_mute(muted: bool) -> BevResult<()> {
        let _g = ComGuard::new()?;
        let ep = endpoint()?;
        unsafe {
            ep.SetMute(muted, std::ptr::null())
                .map_err(|e| BevError::Os(format!("set mute: {e}")))
        }
    }

    pub fn muted() -> BevResult<bool> {
        let _g = ComGuard::new()?;
        let ep = endpoint()?;
        unsafe {
            Ok(ep.GetMute().map_err(|e| BevError::Os(format!("get mute: {e}")))?.as_bool())
        }
    }

    fn process_name(pid: u32) -> String {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        if pid == 0 {
            return "System sounds".into();
        }
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return format!("pid {pid}");
            };
            let mut buf = vec![0u16; 1024];
            let mut size = buf.len() as u32;
            let mut out = format!("pid {pid}");
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok() {
                let full = String::from_utf16_lossy(&buf[..size as usize]);
                let file = full.rsplit(['\\', '/']).next().unwrap_or("").to_string();
                let lower = file.to_lowercase();
                out = if lower.ends_with(".exe") { file[..file.len() - 4].to_string() } else { file };
            }
            let _ = CloseHandle(h);
            out
        }
    }

    /// Every live session on the default playback device, with its volume control.
    fn sessions() -> BevResult<Vec<(AppAudio, ISimpleAudioVolume)>> {
        unsafe {
            let device = enumerator()?
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .map_err(|e| BevError::Os(format!("default endpoint: {e}")))?;
            let mgr: IAudioSessionManager2 = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| BevError::Os(format!("session manager: {e}")))?;
            let list = mgr
                .GetSessionEnumerator()
                .map_err(|e| BevError::Os(format!("session list: {e}")))?;
            let count = list.GetCount().map_err(|e| BevError::Os(format!("session count: {e}")))?;
            let mut out = Vec::new();
            for i in 0..count {
                let Ok(ctl) = list.GetSession(i) else { continue };
                if matches!(ctl.GetState(), Ok(s) if s == AudioSessionStateExpired) {
                    continue;
                }
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() else { continue };
                let pid = ctl2.GetProcessId().unwrap_or(0);
                let volume = vol.GetMasterVolume().map(|v| (v * 100.0).round()).unwrap_or(0.0);
                let muted = vol.GetMute().map(|m| m.as_bool()).unwrap_or(false);
                out.push((AppAudio { app: process_name(pid), pid, volume, muted }, vol));
            }
            Ok(out)
        }
    }

    pub fn list_apps() -> BevResult<Vec<AppAudio>> {
        let _g = ComGuard::new()?;
        let mut v: Vec<AppAudio> = sessions()?.into_iter().map(|(a, _)| a).collect();
        // One app (Chrome, Discord) often owns several sessions; list it once.
        v.sort_by(|a, b| a.app.to_lowercase().cmp(&b.app.to_lowercase()));
        v.dedup_by(|a, b| a.app.eq_ignore_ascii_case(&b.app));
        Ok(v)
    }

    pub fn set_app(app: &str, volume: Option<f32>, muted: Option<bool>) -> BevResult<Vec<AppAudio>> {
        let _g = ComGuard::new()?;
        let all = sessions()?;
        let exact: Vec<&(AppAudio, ISimpleAudioVolume)> =
            all.iter().filter(|(a, _)| app_key(&a.app) == app_key(app)).collect();
        let hits = if exact.is_empty() {
            all.iter().filter(|(a, _)| app_matches(&a.app, app)).collect()
        } else {
            exact
        };
        if hits.is_empty() {
            return Err(BevError::NotFound(format!("no app called \"{app}\" is playing sound right now")));
        }
        let mut changed = Vec::new();
        unsafe {
            for (a, vol) in hits {
                if let Some(v) = volume {
                    vol.SetMasterVolume(v / 100.0, std::ptr::null())
                        .map_err(|e| BevError::Os(format!("set {} volume: {e}", a.app)))?;
                }
                if let Some(m) = muted {
                    vol.SetMute(m, std::ptr::null())
                        .map_err(|e| BevError::Os(format!("mute {}: {e}", a.app)))?;
                }
                changed.push(AppAudio {
                    app: a.app.clone(),
                    pid: a.pid,
                    volume: volume.map(|v| v.round()).unwrap_or(a.volume),
                    muted: muted.unwrap_or(a.muted),
                });
            }
        }
        changed.dedup_by(|a, b| a.app.eq_ignore_ascii_case(&b.app));
        Ok(changed)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn list_apps() -> BevResult<Vec<AppAudio>> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn set_app(_a: &str, _v: Option<f32>, _m: Option<bool>) -> BevResult<Vec<AppAudio>> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn get() -> BevResult<f32> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn set(_p: f32) -> BevResult<()> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn set_mute(_m: bool) -> BevResult<()> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn muted() -> BevResult<bool> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn list_outputs() -> BevResult<Vec<OutputDevice>> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn set_output(_id: &str) -> BevResult<()> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn list_inputs() -> BevResult<Vec<InputDevice>> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn set_default_input(_id: &str) -> BevResult<()> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
    pub fn set_input_level(_id: &str, _v: Option<f32>, _m: Option<bool>) -> BevResult<()> {
        Err(BevError::Unsupported("audio control is Windows-only".into()))
    }
}

/// Recording devices with Windows' mute state and input level.
#[tauri::command]
pub fn list_input_devices() -> BevResult<Vec<InputDevice>> {
    imp::list_inputs()
}

/// Make `id` the Windows default microphone (speech recognition uses it).
#[tauri::command]
pub fn set_default_input_device(id: String) -> BevResult<()> {
    imp::set_default_input(&id)
}

/// Set a microphone's Windows input level (0..1) and/or mute.
#[tauri::command]
pub fn set_input_device_level(id: String, volume: Option<f32>, muted: Option<bool>) -> BevResult<()> {
    imp::set_input_level(&id, volume, muted)
}

#[tauri::command]
pub fn get_volume() -> BevResult<f32> {
    imp::get()
}

#[tauri::command]
pub fn set_volume(percent: f32) -> BevResult<()> {
    imp::set(percent)
}

#[tauri::command]
pub fn set_muted(muted: bool) -> BevResult<()> {
    imp::set_mute(muted)
}

#[tauri::command]
pub fn is_muted() -> BevResult<bool> {
    imp::muted()
}

/// Active playback devices, flagging the one Windows currently uses.
#[tauri::command]
pub fn list_output_devices() -> BevResult<Vec<OutputDevice>> {
    imp::list_outputs()
}

/// Make `id` the Windows default playback device (all sound follows it).
#[tauri::command]
pub fn set_output_device(id: String) -> BevResult<()> {
    if id.trim().is_empty() {
        return Err(BevError::Invalid("output device id is empty".into()));
    }
    imp::set_output(&id)
}

/// Apps playing sound right now, with their own mixer volume and mute state.
#[tauri::command]
pub fn list_app_audio() -> BevResult<Vec<AppAudio>> {
    imp::list_apps()
}

/// Set one app's mixer volume (0..100) and/or mute it, matched by name.
#[tauri::command]
pub fn set_app_audio(app: String, volume: Option<f32>, muted: Option<bool>) -> BevResult<Vec<AppAudio>> {
    if app_key(&app).is_empty() {
        return Err(BevError::Invalid("app name is empty".into()));
    }
    if let Some(v) = volume {
        if !(0.0..=100.0).contains(&v) {
            return Err(BevError::Invalid("volume must be 0..100".into()));
        }
    }
    if volume.is_none() && muted.is_none() {
        return Err(BevError::Invalid("give a volume or a mute state".into()));
    }
    imp::set_app(&app, volume, muted)
}

#[cfg(test)]
mod app_tests {
    use super::*;
    #[test]
    fn matching() {
        assert!(app_matches("Spotify", "spotify"));
        assert!(app_matches("Spotify", "Spotify.exe"));
        assert!(app_matches("DiscordPTB", "discord"));
        assert!(app_matches("Discord", "discord app"));
        assert!(!app_matches("vlc", "valorant"));
        assert!(!app_matches("Spotify", ""));
        assert!(!app_matches("pid 5", "chrome"));
    }
}
