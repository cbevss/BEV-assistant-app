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

/// Windows virtual-key code → Linux evdev keycode (what the portal takes).
pub fn vk_to_evdev(vk: u16) -> Option<i32> {
    Some(match vk {
        0x08 => 14,  // backspace
        0x09 => 15,  // tab
        0x0D => 28,  // enter
        0x10 | 0xA0 => 42,
        0xA1 => 54,
        0x11 | 0xA2 => 29,
        0xA3 => 97,
        0x12 | 0xA4 => 56,
        0xA5 => 100,
        0x13 => 119, // pause
        0x14 => 58,  // caps lock
        0x1B => 1,   // esc
        0x20 => 57,  // space
        0x21 => 104,
        0x22 => 109,
        0x23 => 107,
        0x24 => 102,
        0x25 => 105,
        0x26 => 103,
        0x27 => 106,
        0x28 => 108,
        0x2C => 99, // print screen
        0x2D => 110,
        0x2E => 111,
        0x30 => 11,
        0x31..=0x39 => (vk - 0x31) as i32 + 2,
        0x41..=0x5A => {
            const LETTERS: [i32; 26] = [30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44];
            LETTERS[(vk - 0x41) as usize]
        }
        0x5B => 125, // super
        0x5C => 126,
        0x5D => 127, // menu
        0x60 => 82,
        0x61 => 79,
        0x62 => 80,
        0x63 => 81,
        0x64 => 75,
        0x65 => 76,
        0x66 => 77,
        0x67 => 71,
        0x68 => 72,
        0x69 => 73,
        0x6A => 55,
        0x6B => 78,
        0x6D => 74,
        0x6E => 83,
        0x6F => 98,
        0x70..=0x79 => (vk - 0x70) as i32 + 59, // F1-F10
        0x7A => 87,
        0x7B => 88,
        0x90 => 69,
        0x91 => 70,
        0xAD => 113, // mute
        0xAE => 114,
        0xAF => 115,
        0xB0 => 163, // next
        0xB1 => 165, // previous
        0xB2 => 166, // stop
        0xB3 => 164, // play/pause
        0xBA => 39,
        0xBB => 13,
        0xBC => 51,
        0xBD => 12,
        0xBE => 52,
        0xBF => 53,
        0xC0 => 41,
        0xDB => 26,
        0xDC => 43,
        0xDD => 27,
        0xDE => 40,
        _ => return None,
    })
}

/// X keysym for a character: control keys by name, Latin-1 directly, the
/// rest through the Unicode keysym range.
pub fn char_keysym(c: char) -> i32 {
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        '\u{8}' => 0xff08,
        c if (c as u32) >= 0x20 && (c as u32) <= 0x7e => c as i32,
        c if (c as u32) >= 0xa0 && (c as u32) <= 0xff => c as i32,
        c => 0x0100_0000 | c as i32,
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use crate::control::portal::{self, Op, BTN_LEFT, BTN_RIGHT};

    fn code(vk: u16) -> Result<i32, String> {
        vk_to_evdev(vk).ok_or_else(|| format!("BEV can't press that key on Linux yet (key 0x{vk:02X})"))
    }

    pub fn press(combos: &[Combo]) -> Result<(), String> {
        let mut ops = Vec::new();
        for c in combos {
            let mods: Vec<i32> = c.mods.iter().map(|&m| code(m)).collect::<Result<_, _>>()?;
            for &m in &mods {
                ops.push(Op::Key(m, true));
            }
            if let Some(k) = c.key {
                let k = code(k)?;
                ops.push(Op::Key(k, true));
                ops.push(Op::Key(k, false));
            }
            for &m in mods.iter().rev() {
                ops.push(Op::Key(m, false));
            }
            ops.push(Op::Sleep(30));
        }
        portal::send(ops)
    }

    pub fn type_text(text: &str) -> Result<(), String> {
        // Send in chunks so a long paste doesn't hold the worker for ages.
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(200) {
            let mut ops = Vec::with_capacity(chunk.len() * 2);
            for &c in chunk {
                let sym = char_keysym(c);
                ops.push(Op::Keysym(sym, true));
                ops.push(Op::Keysym(sym, false));
            }
            portal::send(ops)?;
        }
        Ok(())
    }

    pub fn click(x: i32, y: i32, right: bool, double: bool) -> Result<(), String> {
        let b = if right { BTN_RIGHT } else { BTN_LEFT };
        let mut ops = vec![Op::Move(x, y), Op::Sleep(30), Op::Button(b, true), Op::Button(b, false)];
        if double {
            ops.extend([Op::Sleep(60), Op::Button(b, true), Op::Button(b, false)]);
        }
        portal::send(ops)
    }

    pub fn scroll(x: i32, y: i32, notches: i32, horizontal: bool) -> Result<(), String> {
        // BEV's notches follow Windows: positive = up/right. Linux steps: positive = down/right.
        let steps = if horizontal { notches } else { -notches };
        portal::send(vec![Op::Move(x, y), Op::Sleep(20), Op::Scroll { horizontal, steps }])
    }

    pub fn cursor_pos() -> Option<(i32, i32)> {
        portal::LAST_POS.lock().ok().and_then(|g| *g)
    }

    pub fn hover(x: i32, y: i32) -> Result<(), String> {
        portal::send(vec![Op::Move(x, y)])
    }

    pub fn drag(from: (i32, i32), to: (i32, i32)) -> Result<(), String> {
        let mut ops = vec![Op::Move(from.0, from.1), Op::Sleep(50), Op::Button(BTN_LEFT, true), Op::Sleep(80)];
        for i in 1..=10 {
            let x = from.0 + (to.0 - from.0) * i / 10;
            let y = from.1 + (to.1 - from.1) * i / 10;
            ops.push(Op::Move(x, y));
            ops.push(Op::Sleep(15));
        }
        ops.extend([Op::Sleep(50), Op::Button(BTN_LEFT, false)]);
        portal::send(ops)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::*;
    const NO: &str = "keyboard and mouse control isn't supported on this OS";
    pub fn press(_c: &[Combo]) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn type_text(_t: &str) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn click(_x: i32, _y: i32, _r: bool, _d: bool) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn scroll(_x: i32, _y: i32, _n: i32, _h: bool) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn cursor_pos() -> Option<(i32, i32)> {
        None
    }
    pub fn hover(_x: i32, _y: i32) -> Result<(), String> {
        Err(NO.into())
    }
    pub fn drag(_f: (i32, i32), _t: (i32, i32)) -> Result<(), String> {
        Err(NO.into())
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

    #[test]
    fn maps_keys_to_evdev() {
        use super::vk_to_evdev;
        assert_eq!(vk_to_evdev(0x41), Some(30)); // A
        assert_eq!(vk_to_evdev(0x5A), Some(44)); // Z
        assert_eq!(vk_to_evdev(0x31), Some(2)); // 1
        assert_eq!(vk_to_evdev(0x30), Some(11)); // 0
        assert_eq!(vk_to_evdev(0x70), Some(59)); // F1
        assert_eq!(vk_to_evdev(0x7B), Some(88)); // F12
        assert_eq!(vk_to_evdev(0x11), Some(29)); // ctrl
        assert_eq!(vk_to_evdev(0x5B), Some(125)); // super
        assert_eq!(vk_to_evdev(0xFF), None);
    }

    #[test]
    fn keysyms_for_text() {
        use super::char_keysym;
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym('\n'), 0xff0d);
        assert_eq!(char_keysym('é'), 0xe9);
        assert_eq!(char_keysym('€'), 0x0100_20ac);
    }
}
