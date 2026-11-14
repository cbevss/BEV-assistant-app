//! Installed games. Steam: finds the Steam folder, reads every library listed
//! in `steamapps/libraryfolders.vdf` (games can live on several drives), and
//! each `appmanifest_<appid>.acf` for the game's name.
//! Games always launch through Steam, so they start on the logged-in Steam
//! account, picking the launch option without Steam's chooser dialog:
//! - online:  `steam://launch/<appid>/option0`, the first option
//!   (e.g. "Play Rocket League", with Easy Anti-Cheat)
//! - offline: `steam://launch/<appid>/option1`, the second option
//!   (e.g. "Play Rocket League with Anti-Cheat Disabled")

use crate::error::{BevError, BevResult};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Game {
    /// Steam app id (digits only).
    pub id: String,
    pub name: String,
    pub source: &'static str,
}

/// Steam installs these alongside games; they aren't things you'd "open".
const NOT_GAMES: &[&str] = &[
    "steamworks common redistributables",
    "steam linux runtime",
    "proton",
    "steamvr",
    "steam controller configs",
];

/// Every `"key" "value"` pair in Valve's KeyValues text (.vdf / .acf), in file
/// order. Nesting is ignored: the fields BEV needs are unambiguous by key.
pub(crate) fn vdf_pairs(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut tokens = Vec::new();
        let mut chars = line.chars();
        while let Some(c) = chars.next() {
            if c != '"' {
                continue;
            }
            let mut tok = String::new();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => {
                        if let Some(n) = chars.next() {
                            tok.push(n); // \\ → \ and \" → "
                        }
                    }
                    '"' => break,
                    _ => tok.push(c),
                }
            }
            tokens.push(tok);
        }
        if tokens.len() == 2 {
            let mut it = tokens.into_iter();
            out.push((it.next().unwrap(), it.next().unwrap()));
        }
    }
    out
}

/// Library folders listed in `libraryfolders.vdf`.
pub(crate) fn library_paths(vdf: &str) -> Vec<PathBuf> {
    vdf_pairs(vdf)
        .into_iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("path"))
        .map(|(_, v)| PathBuf::from(v))
        .collect()
}

/// The game in one `appmanifest_*.acf`, or None for tools/runtimes.
pub(crate) fn manifest_game(acf: &str) -> Option<Game> {
    let pairs = vdf_pairs(acf);
    let get = |key: &str| {
        pairs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.trim().to_string())
    };
    let id = get("appid")?;
    let name = get("name")?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) || name.is_empty() {
        return None;
    }
    let lower = name.to_lowercase();
    if NOT_GAMES.iter().any(|n| lower.starts_with(n)) {
        return None;
    }
    Some(Game { id, name, source: "steam" })
}

/// All games installed in the Steam folder `root` and its other libraries.
pub(crate) fn steam_games_in(root: &Path) -> Vec<Game> {
    let mut libraries = vec![root.to_path_buf()];
    if let Ok(vdf) = std::fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        for p in library_paths(&vdf) {
            if !libraries.iter().any(|l| same_path(l, &p)) {
                libraries.push(p);
            }
        }
    }
    let mut games: Vec<Game> = Vec::new();
    for lib in libraries {
        let Ok(entries) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        for entry in entries.flatten() {
            let file = entry.file_name();
            let file = file.to_string_lossy();
            if !(file.starts_with("appmanifest_") && file.ends_with(".acf")) {
                continue;
            }
            if let Some(g) = std::fs::read_to_string(entry.path()).ok().as_deref().and_then(manifest_game) {
                if !games.iter().any(|x| x.id == g.id) {
                    games.push(g);
                }
            }
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    norm(a) == norm(b)
}

/// Steam's install folder: the registry first, then the default locations.
fn steam_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    if let Some(p) = registry_steam_path() {
        candidates.push(p);
    }
    candidates.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    candidates.push(PathBuf::from(r"C:\Program Files\Steam"));
    candidates.into_iter().find(|p| p.join("steamapps").is_dir())
}

#[cfg(windows)]
fn registry_steam_path() -> Option<PathBuf> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    let mut buf = [0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam"),
            w!("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let s = String::from_utf16_lossy(&buf[..len]);
    (!s.is_empty()).then(|| PathBuf::from(s))
}

/// Installed Steam games, sorted by name.
#[tauri::command]
pub fn list_games() -> BevResult<Vec<Game>> {
    let root = steam_root().ok_or_else(|| BevError::NotFound("Steam isn't installed (or isn't in its usual folder)".into()))?;
    Ok(steam_games_in(&root))
}

/// Launch an installed Steam game through Steam, by app id. `mode` "online"
/// picks its first launch option, "offline" its second (for Rocket League:
/// with / without Easy Anti-Cheat). Only ids of installed games are accepted.
#[tauri::command]
pub fn launch_game(id: String, mode: String) -> BevResult<String> {
    if id.is_empty() || id.len() > 12 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(BevError::Invalid("game id must be a Steam app number".into()));
    }
    let option = match mode.as_str() {
        "online" => 0,
        "offline" => 1,
        _ => return Err(BevError::Invalid("mode must be \"online\" or \"offline\"".into())),
    };
    let root = steam_root().ok_or_else(|| BevError::NotFound("Steam isn't installed".into()))?;
    let game = steam_games_in(&root)
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| BevError::NotFound(format!("no installed Steam game with id {id}")))?;
    open_steam_url(&format!("steam://launch/{id}/option{option}"))
        .map(|_| format!("launched {} {mode} through Steam", game.name))
}

/// Hand a steam:// URL to the Steam client. Only built from digits above.
fn open_steam_url(url: &str) -> BevResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(BevError::NotFound("Steam didn't respond to the launch request".into()))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err(BevError::Unsupported("game launch is Windows-only".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes copied from real Steam files.
    const LIBRARY_VDF: &str = r#""libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"contentid"		"6421373526094712394"
		"totalsize"		"0"
		"apps"
		{
			"228980"		"406702045"
			"252950"		"21360735593"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"label"		""
		"apps"
		{
			"730"		"37023465422"
		}
	}
}"#;

    const ROCKET_ACF: &str = r#""AppState"
{
	"appid"		"252950"
	"universe"		"1"
	"name"		"Rocket League"
	"StateFlags"		"4"
	"installdir"		"rocketleague"
	"InstalledDepots"
	{
		"252951"
		{
			"manifest"		"4416862962326018004"
		}
	}
}"#;

    #[test]
    fn reads_every_library_path() {
        assert_eq!(
            library_paths(LIBRARY_VDF),
            vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"D:\SteamLibrary")]
        );
    }

    #[test]
    fn reads_a_game_manifest() {
        assert_eq!(
            manifest_game(ROCKET_ACF),
            Some(Game { id: "252950".into(), name: "Rocket League".into(), source: "steam" })
        );
    }

    #[test]
    fn skips_runtimes_and_redistributables() {
        let acf = ROCKET_ACF.replace("252950", "228980").replace("Rocket League", "Steamworks Common Redistributables");
        assert_eq!(manifest_game(&acf), None);
    }

    #[test]
    fn handles_escaped_quotes_in_names() {
        let acf = ROCKET_ACF.replace("Rocket League", r#"Tom Clancy\'s \"Test\" Game"#);
        assert_eq!(manifest_game(&acf).unwrap().name, r#"Tom Clancy's "Test" Game"#);
    }

    #[test]
    fn finds_games_across_libraries() {
        let base = std::env::temp_dir().join(format!("bev-steam-{}", std::process::id()));
        let main = base.join("Steam");
        let second = base.join("SteamLibrary");
        std::fs::create_dir_all(main.join("steamapps")).unwrap();
        std::fs::create_dir_all(second.join("steamapps")).unwrap();
        let vdf = format!(
            "\"libraryfolders\"\n{{\n\"0\"\n{{\n\"path\"\t\t\"{}\"\n}}\n\"1\"\n{{\n\"path\"\t\t\"{}\"\n}}\n}}",
            main.display().to_string().replace('\\', "\\\\"),
            second.display().to_string().replace('\\', "\\\\")
        );
        std::fs::write(main.join("steamapps/libraryfolders.vdf"), vdf).unwrap();
        std::fs::write(main.join("steamapps/appmanifest_252950.acf"), ROCKET_ACF).unwrap();
        std::fs::write(
            second.join("steamapps/appmanifest_730.acf"),
            ROCKET_ACF.replace("252950", "730").replace("Rocket League", "Counter-Strike 2"),
        )
        .unwrap();
        std::fs::write(second.join("steamapps/not_a_manifest.txt"), "x").unwrap();

        let names: Vec<String> = steam_games_in(&main).into_iter().map(|g| g.name).collect();
        assert_eq!(names, vec!["Counter-Strike 2", "Rocket League"]);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn launch_rejects_anything_but_digits() {
        for bad in ["", "252950 & calc", "abc", "1234567890123"] {
            assert!(launch_game(bad.into(), "online".into()).is_err(), "{bad:?} should be rejected");
        }
        assert!(launch_game("252950".into(), "sideways".into()).is_err(), "unknown mode should be rejected");
    }
}
