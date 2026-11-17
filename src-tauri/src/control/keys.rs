//! Parse key descriptions like "ctrl+s", "alt+tab", "enter" or
//! "ctrl+a, ctrl+c" into virtual-key codes. Pure, so it's tested on any OS.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    /// Modifier VKs, pressed in order and released in reverse.
    pub mods: Vec<u16>,
    /// The main key (None for a lone modifier such as "win").
    pub key: Option<u16>,
    /// Lower-case canonical text, e.g. "ctrl+shift+s".
    pub text: String,
}

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12; // Alt
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_DELETE: u16 = 0x2E;

fn modifier(t: &str) -> Option<(u16, &'static str)> {
    Some(match t {
        "ctrl" | "control" | "ctl" => (VK_CONTROL, "ctrl"),
        "shift" => (VK_SHIFT, "shift"),
        "alt" | "option" => (VK_MENU, "alt"),
        "win" | "windows" | "meta" | "super" | "cmd" | "start" => (VK_LWIN, "win"),
        _ => return None,
    })
}

fn key(t: &str) -> Option<u16> {
    let b = t.as_bytes();
    if b.len() == 1 {
        let c = b[0];
        if c.is_ascii_lowercase() {
            return Some(c.to_ascii_uppercase() as u16);
        }
        if c.is_ascii_digit() {
            return Some(c as u16);
        }
        return Some(match c {
            b';' => 0xBA,
            b'=' => 0xBB,
            b',' => 0xBC,
            b'-' => 0xBD,
            b'.' => 0xBE,
            b'/' => 0xBF,
            b'`' => 0xC0,
            b'[' => 0xDB,
            b'\\' => 0xDC,
            b']' => 0xDD,
            b'\'' => 0xDE,
            _ => return None,
        });
    }
    if let Some(n) = t.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x6F + n);
        }
    }
    Some(match t {
        "enter" | "return" => VK_RETURN,
        "esc" | "escape" => 0x1B,
        "tab" => 0x09,
        "space" | "spacebar" => 0x20,
        "backspace" | "back" => 0x08,
        "delete" | "del" => VK_DELETE,
        "insert" | "ins" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "up" | "arrowup" => 0x26,
        "down" | "arrowdown" => 0x28,
        "left" | "arrowleft" => 0x25,
        "right" | "arrowright" => 0x27,
        "printscreen" | "prtsc" => 0x2C,
        "menu" | "apps" | "contextmenu" => 0x5D,
        "plus" => 0xBB,
        "minus" => 0xBD,
        "comma" => 0xBC,
        "period" | "dot" => 0xBE,
        "volumeup" => 0xAF,
        "volumedown" => 0xAE,
        "volumemute" | "mute" => 0xAD,
        "playpause" | "play" | "pause" => 0xB3,
        "nexttrack" | "next" => 0xB0,
        "prevtrack" | "previous" | "prev" => 0xB1,
        "stop" => 0xB2,
        _ => return None,
    })
}

/// "ctrl+shift+s" → Combo. Errors name the part that wasn't understood.
pub fn parse_combo(s: &str) -> Result<Combo, String> {
    let s = s.trim().to_lowercase();
    if s.is_empty() {
        return Err("no keys given".into());
    }
    // "ctrl++" means ctrl and plus.
    let normalised = s.replace("++", "+plus").replace(' ', "");
    let mut mods = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut main = None;
    let parts: Vec<&str> = normalised.split('+').filter(|p| !p.is_empty()).collect();
    for (i, p) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        if let Some((vk, name)) = modifier(p) {
            if !mods.contains(&vk) {
                mods.push(vk);
                names.push(name.into());
            }
            continue;
        }
        if !last {
            return Err(format!("\"{p}\" can only be the last key in \"{s}\""));
        }
        main = Some(key(p).ok_or_else(|| format!("unknown key \"{p}\""))?);
        names.push((*p).to_string());
    }
    if mods.is_empty() && main.is_none() {
        return Err(format!("no keys in \"{s}\""));
    }
    Ok(Combo { mods, key: main, text: names.join("+") })
}

/// "ctrl+a, ctrl+c" or "ctrl+a then ctrl+c" → several combos, at most 20.
pub fn parse_sequence(s: &str) -> Result<Vec<Combo>, String> {
    let s = s.to_lowercase().replace(" then ", ",");
    let combos = s.split(',').filter(|p| !p.trim().is_empty()).map(parse_combo).collect::<Result<Vec<_>, _>>()?;
    if combos.is_empty() {
        return Err("no keys given".into());
    }
    if combos.len() > 20 {
        return Err("too many key presses at once (20 max)".into());
    }
    Ok(combos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_combos() {
        let c = parse_combo("Ctrl+Shift+S").unwrap();
        assert_eq!(c.mods, vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(c.key, Some(b'S' as u16));
        assert_eq!(c.text, "ctrl+shift+s");
        assert_eq!(parse_combo("alt + tab").unwrap().key, Some(0x09));
        assert_eq!(parse_combo("enter").unwrap().key, Some(VK_RETURN));
        assert_eq!(parse_combo("f5").unwrap().key, Some(0x74));
        assert_eq!(parse_combo("f12").unwrap().key, Some(0x7B));
        assert_eq!(parse_combo("ctrl++").unwrap().key, Some(0xBB));
        assert_eq!(parse_combo("1").unwrap().key, Some(b'1' as u16));
    }

    #[test]
    fn lone_modifier_is_allowed() {
        let c = parse_combo("win").unwrap();
        assert_eq!(c.mods, vec![VK_LWIN]);
        assert_eq!(c.key, None);
    }

    #[test]
    fn rejects_nonsense() {
        assert!(parse_combo("").is_err());
        assert!(parse_combo("ctrl+banana").unwrap_err().contains("banana"));
        assert!(parse_combo("s+ctrl").is_err()); // the main key must come last
        assert!(parse_combo("a+b").is_err());
        assert!(parse_combo("f25").is_err());
    }

    #[test]
    fn sequences() {
        let s = parse_sequence("ctrl+a, ctrl+c").unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(parse_sequence("ctrl+a then ctrl+v").unwrap()[1].text, "ctrl+v");
        assert!(parse_sequence(&vec!["a"; 21].join(",")).is_err());
    }
}
