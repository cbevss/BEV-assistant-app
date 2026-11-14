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

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use windows::core::{Interface, IUnknown, GUID, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eCommunications, eConsole, eMultimedia, eRender, ERole, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
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
        let _g = ComGuard::new()?;

        // Only accept an id that is a currently active playback endpoint.
        let enumerator = enumerator()?;
        let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            let known = enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|e| BevError::Os(format!("enumerate outputs: {e}")))?;
            let count = known
                .GetCount()
                .map_err(|e| BevError::Os(format!("count outputs: {e}")))?;
            let exists = (0..count)
                .filter_map(|i| known.Item(i).ok())
                .any(|d| device_id(&d).map(|d| d == id).unwrap_or(false));
            if !exists {
                return Err(BevError::NotFound("that output device is no longer available".into()));
            }

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
                    .map_err(|e| BevError::Os(format!("set default output: {e}")))?;
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
}

#[cfg(not(windows))]
mod imp {
    use super::*;
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
