//! Hard limits on keyboard and mouse control, enforced natively so nothing the
//! AI reads or is told can talk its way past them. Pure, so it's tested here.

use super::keys::{Combo, VK_LWIN};

/// Key combos BEV never sends: they open places where typed text runs as a command.
pub fn blocked_combo(c: &Combo) -> Option<&'static str> {
    if c.mods.contains(&VK_LWIN) {
        match c.key {
            Some(k) if k == b'R' as u16 => return Some("BEV doesn't open the Run box (Win+R): typed text there runs as a command."),
            Some(k) if k == b'X' as u16 => return Some("BEV doesn't open the Win+X admin menu."),
            _ => {}
        }
    }
    None
}

/// Processes where typed text becomes a command or changes system settings.
const NO_TYPING: &[&str] = &[
    "cmd.exe",
    "powershell.exe",
    "powershell_ise.exe",
    "pwsh.exe",
    "windowsterminal.exe",
    "wt.exe",
    "conhost.exe",
    "openconsole.exe",
    "wsl.exe",
    "bash.exe",
    "mintty.exe",
    "alacritty.exe",
    "wezterm-gui.exe",
    "putty.exe",
    "regedit.exe",
    "consent.exe",
    "searchhost.exe",
    "searchapp.exe",
    "startmenuexperiencehost.exe",
];

/// Why BEV won't type or press keys into this window, if it won't.
pub fn typing_blocked(process: &str, class: &str, title: &str) -> Option<String> {
    let p = process.to_ascii_lowercase();
    let p = p.rsplit(['\\', '/']).next().unwrap_or(&p);
    if NO_TYPING.contains(&p) {
        let what = match p {
            "regedit.exe" => "the Registry Editor",
            "consent.exe" => "a Windows security prompt",
            "searchhost.exe" | "searchapp.exe" | "startmenuexperiencehost.exe" => "Start/Search (typed text there can launch anything)",
            _ => "a terminal (typed text there runs as a command)",
        };
        return Some(format!("BEV doesn't type into {what}. Open a normal app, or do this part yourself."));
    }
    if class == "#32770" && title.trim().eq_ignore_ascii_case("run") {
        return Some("BEV doesn't type into the Run box: typed text there runs as a command.".into());
    }
    None
}

/// No synthetic input while a game owns the screen.
pub fn game_blocks_input(fullscreen_state: &str) -> Option<&'static str> {
    (fullscreen_state == "exclusive").then_some("A fullscreen game is in front, so BEV won't send keys or clicks to it.")
}

/// Where a screenshot came from, so points on it can be mapped back to the desktop.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShotGeom {
    pub origin_x: i32,
    pub origin_y: i32,
    /// Captured size in real pixels.
    pub src_w: u32,
    pub src_h: u32,
    /// Size of the (downscaled) image the AI saw.
    pub img_w: u32,
    pub img_h: u32,
}

/// A point on the screenshot → desktop pixels. None if it's off the image.
pub fn shot_to_screen(g: &ShotGeom, x: f64, y: f64) -> Option<(i32, i32)> {
    if g.img_w == 0 || g.img_h == 0 || x < 0.0 || y < 0.0 || x > g.img_w as f64 || y > g.img_h as f64 {
        return None;
    }
    let sx = g.src_w as f64 / g.img_w as f64;
    let sy = g.src_h as f64 / g.img_h as f64;
    Some((g.origin_x + (x * sx).round() as i32, g.origin_y + (y * sy).round() as i32))
}

/// Scale factor (≤ 1) that fits an image within `max` on its long edge.
pub fn fit_scale(w: u32, h: u32, max: u32) -> f64 {
    let long = w.max(h);
    if long <= max || long == 0 {
        1.0
    } else {
        max as f64 / long as f64
    }
}

#[cfg(test)]
mod tests {
    use super::super::keys::parse_combo;
    use super::*;

    #[test]
    fn blocks_run_and_admin_menu() {
        assert!(blocked_combo(&parse_combo("win+r").unwrap()).is_some());
        assert!(blocked_combo(&parse_combo("win+x").unwrap()).is_some());
        assert!(blocked_combo(&parse_combo("win+d").unwrap()).is_none());
        assert!(blocked_combo(&parse_combo("ctrl+r").unwrap()).is_none());
    }

    #[test]
    fn no_typing_into_terminals_or_run() {
        assert!(typing_blocked("C:\\Windows\\System32\\cmd.exe", "", "").is_some());
        assert!(typing_blocked("WindowsTerminal.exe", "", "").is_some());
        assert!(typing_blocked("regedit.exe", "", "").unwrap().contains("Registry"));
        assert!(typing_blocked("explorer.exe", "#32770", "Run").is_some());
        assert!(typing_blocked("notepad.exe", "Notepad", "Untitled").is_none());
        assert!(typing_blocked("explorer.exe", "#32770", "Properties").is_none());
    }

    #[test]
    fn game_guard() {
        assert!(game_blocks_input("exclusive").is_some());
        assert!(game_blocks_input("borderless").is_none());
        assert!(game_blocks_input("none").is_none());
    }

    #[test]
    fn maps_screenshot_points() {
        let g = ShotGeom { origin_x: 1920, origin_y: 0, src_w: 2560, src_h: 1440, img_w: 1568, img_h: 882 };
        assert_eq!(shot_to_screen(&g, 0.0, 0.0), Some((1920, 0)));
        assert_eq!(shot_to_screen(&g, 784.0, 441.0), Some((1920 + 1280, 720)));
        assert_eq!(shot_to_screen(&g, 1600.0, 10.0), None);
        assert_eq!(shot_to_screen(&g, -1.0, 10.0), None);
    }

    #[test]
    fn fit() {
        assert_eq!(fit_scale(1000, 500, 2000), 1.0);
        assert!((fit_scale(5120, 1440, 2560) - 0.5).abs() < 1e-9);
    }
}
