//! System volume + mute via the Windows Core Audio API.
//! All calls fail closed with a readable error if COM is unavailable.

use crate::error::{BevError, BevResult};

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::Interface;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    struct ComGuard;
    impl ComGuard {
        fn new() -> BevResult<Self> {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED)
                    .ok()
                    .map_err(|e| BevError::Os(format!("CoInitializeEx: {e}")))?;
            }
            Ok(ComGuard)
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
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
