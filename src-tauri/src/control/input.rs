//! Synthetic keyboard and mouse input (SendInput). Callers check the guards first.

use super::keys::Combo;

/// Keys that need the extended-key flag to reach apps correctly.
pub fn is_extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5 | 0xAD..=0xB3)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::time::Duration;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
        VIRTUAL_KEY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

    fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn vk(vk: u16, up: bool) -> INPUT {
        let mut f = KEYBD_EVENT_FLAGS(0);
        if is_extended(vk) {
            f |= KEYEVENTF_EXTENDEDKEY;
        }
        if up {
            f |= KEYEVENTF_KEYUP;
        }
        key_input(vk, 0, f)
    }

    fn send(inputs: &[INPUT]) -> Result<(), String> {
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != inputs.len() {
            // Windows blocks input into windows running as administrator from a normal app (UIPI).
            return Err("Windows blocked the input (the app may be running as administrator).".into());
        }
        Ok(())
    }

    pub fn press(combos: &[Combo]) -> Result<(), String> {
        for c in combos {
            let mut seq = Vec::new();
            for &m in &c.mods {
                seq.push(vk(m, false));
            }
            if let Some(k) = c.key {
                seq.push(vk(k, false));
                seq.push(vk(k, true));
            }
            for &m in c.mods.iter().rev() {
                seq.push(vk(m, true));
            }
            send(&seq)?;
            std::thread::sleep(Duration::from_millis(60));
        }
        Ok(())
    }

    /// Type text as Unicode characters (layout-independent). Newlines press Enter.
    pub fn type_text(text: &str) -> Result<(), String> {
        let mut batch = Vec::new();
        for ch in text.chars() {
            if ch == '\r' {
                continue;
            }
            if ch == '\n' {
                batch.push(vk(0x0D, false));
                batch.push(vk(0x0D, true));
                continue;
            }
            if ch == '\t' {
                batch.push(vk(0x09, false));
                batch.push(vk(0x09, true));
                continue;
            }
            let mut buf = [0u16; 2];
            for unit in ch.encode_utf16(&mut buf) {
                batch.push(key_input(0, *unit, KEYEVENTF_UNICODE));
                batch.push(key_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            if batch.len() >= 64 {
                send(&batch)?;
                batch.clear();
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        send(&batch)
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    fn wheel(flags: MOUSE_EVENT_FLAGS, delta: i32) -> INPUT {
        INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: delta as _, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    fn cursor() -> Option<POINT> {
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p).is_ok() }.then_some(p)
    }

    pub fn cursor_pos() -> Option<(i32, i32)> {
        cursor().map(|p| (p.x, p.y))
    }

    /// Scroll the wheel over a point (`notches` > 0 scrolls up / right), then
    /// put the pointer back. One notch is one wheel click (WHEEL_DELTA 120).
    pub fn scroll(x: i32, y: i32, notches: i32, horizontal: bool) -> Result<(), String> {
        let was = cursor();
        unsafe { SetCursorPos(x, y) }.map_err(|e| format!("couldn't move the pointer: {e}"))?;
        std::thread::sleep(Duration::from_millis(30));
        let flags = if horizontal { MOUSEEVENTF_HWHEEL } else { MOUSEEVENTF_WHEEL };
        let step = if notches >= 0 { 120 } else { -120 };
        let r = (|| {
            for _ in 0..notches.unsigned_abs() {
                send(&[wheel(flags, step)])?;
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(())
        })();
        std::thread::sleep(Duration::from_millis(40));
        if let Some(p) = was {
            let _ = unsafe { SetCursorPos(p.x, p.y) };
        }
        r
    }

    /// Rest the pointer on a point (to open a hover menu or tooltip). It stays there.
    pub fn hover(x: i32, y: i32) -> Result<(), String> {
        unsafe { SetCursorPos(x, y) }.map_err(|e| format!("couldn't move the pointer: {e}"))
    }

    /// Press at one point, glide to another and release (sliders, drag and drop).
    pub fn drag(from: (i32, i32), to: (i32, i32)) -> Result<(), String> {
        let was = cursor();
        unsafe { SetCursorPos(from.0, from.1) }.map_err(|e| format!("couldn't move the pointer: {e}"))?;
        std::thread::sleep(Duration::from_millis(40));
        send(&[mouse(MOUSEEVENTF_LEFTDOWN)])?;
        // Glide in steps so apps see a real drag, not a teleport.
        let steps = 16;
        let mut r = Ok(());
        for i in 1..=steps {
            let x = from.0 + (to.0 - from.0) * i / steps;
            let y = from.1 + (to.1 - from.1) * i / steps;
            if let Err(e) = unsafe { SetCursorPos(x, y) } {
                r = Err(format!("couldn't move the pointer: {e}"));
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        // Always release, even if a move failed, so the button isn't left held.
        let up = send(&[mouse(MOUSEEVENTF_LEFTUP)]);
        std::thread::sleep(Duration::from_millis(40));
        if let Some(p) = was {
            let _ = unsafe { SetCursorPos(p.x, p.y) };
        }
        r.and(up)
    }

    /// Click at a desktop point, then put the pointer back where the user left it.
    pub fn click(x: i32, y: i32, right: bool, double: bool) -> Result<(), String> {
        let mut was = POINT::default();
        let had = unsafe { GetCursorPos(&mut was).is_ok() };
        unsafe { SetCursorPos(x, y) }.map_err(|e| format!("couldn't move the pointer: {e}"))?;
        std::thread::sleep(Duration::from_millis(30));
        let (down, up) = if right { (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) } else { (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP) };
        let r = (|| {
            send(&[mouse(down), mouse(up)])?;
            if double {
                std::thread::sleep(Duration::from_millis(70));
                send(&[mouse(down), mouse(up)])?;
            }
            Ok(())
        })();
        std::thread::sleep(Duration::from_millis(40));
        if had {
            let _ = unsafe { SetCursorPos(was.x, was.y) };
        }
        r
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn press(_c: &[Combo]) -> Result<(), String> {
        Err("keyboard control is Windows-only".into())
    }
    pub fn type_text(_t: &str) -> Result<(), String> {
        Err("keyboard control is Windows-only".into())
    }
    pub fn click(_x: i32, _y: i32, _r: bool, _d: bool) -> Result<(), String> {
        Err("mouse control is Windows-only".into())
    }
    pub fn scroll(_x: i32, _y: i32, _n: i32, _h: bool) -> Result<(), String> {
        Err("mouse control is Windows-only".into())
    }
    pub fn cursor_pos() -> Option<(i32, i32)> {
        None
    }
    pub fn hover(_x: i32, _y: i32) -> Result<(), String> {
        Err("mouse control is Windows-only".into())
    }
    pub fn drag(_f: (i32, i32), _t: (i32, i32)) -> Result<(), String> {
        Err("mouse control is Windows-only".into())
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    #[test]
    fn extended_keys() {
        assert!(super::is_extended(0x25)); // left
        assert!(super::is_extended(0x2E)); // delete
        assert!(super::is_extended(0x5B)); // win
        assert!(!super::is_extended(0x41)); // A
        assert!(!super::is_extended(0x0D)); // enter
    }
}
