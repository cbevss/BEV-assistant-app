//! Installed games. Steam: finds the Steam folder, reads every library listed
//! in `steamapps/libraryfolders.vdf` (games can live on several drives), and
//! each `appmanifest_<appid>.acf` for the game's name and install folder.
//! Launching runs the game's own .exe from `steamapps/common/<installdir>`
//! (Steam-only games still hand over to Steam themselves); if no .exe can be
//! found it falls back to `steam://rungameid/<appid>`.

use crate::error::{BevError, BevResult};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Game {
    /// Steam app id (digits only).
    pub id: String,
    pub name: String,
    pub source: &'static str,
    /// `steamapps/common/<installdir>` once known; not sent to the UI.
    #[serde(skip)]
    pub install_dir: Option<PathBuf>,
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
    let install_dir = get("installdir").filter(|d| !d.is_empty()).map(PathBuf::from);
    Some(Game { id, name, source: "steam", install_dir })
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
            if let Some(mut g) = std::fs::read_to_string(entry.path()).ok().as_deref().and_then(manifest_game) {
                // installdir is relative to this library's steamapps/common.
                g.install_dir = g.install_dir.map(|d| lib.join("steamapps").join("common").join(d));
                if !games.iter().any(|x| x.id == g.id) {
                    games.push(g);
                }
            }
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// Parts of an .exe name that mark it as a helper rather than the game.
const NOT_THE_GAME: &[&str] = &[
    "unins", "crash", "report", "redist", "vcredist", "directx", "dxsetup", "dotnet", "setup",
    "install", "prereq", "easyanticheat", "battleye", "be_", "updater", "helper",
    "cefprocess", "webhelper", "unitycrashhandler", "ue4prereq", "ueprereq", "touchup", "cleanup",
    "benchmark", "editor", "server", "dedicated",
];

fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase()
}

/// "Counter-Strike 2" → "cs2", "Grand Theft Auto V" → "gtav": many games name
/// their .exe after their initials.
fn initials(name: &str) -> String {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| if w.chars().all(|c| c.is_ascii_digit()) { w.to_string() } else { w[..1].to_lowercase() })
        .collect()
}

/// The game's main executable inside its install folder: the .exe whose name
/// best matches the game, skipping crash reporters, installers, anti-cheat and
/// other helpers. With no name match, the largest remaining .exe (the game is
/// almost always the biggest binary).
pub(crate) fn find_main_exe(dir: &Path, game_name: &str) -> Option<PathBuf> {
    let mut exes: Vec<(PathBuf, u64, usize)> = Vec::new(); // path, size, depth
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                let lower = e.file_name().to_string_lossy().to_lowercase();
                // Redistributable installers live in these; never the game.
                if depth < 5 && !lower.starts_with('_') && !lower.contains("redist") {
                    stack.push((path, depth + 1));
                }
            } else if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) {
                exes.push((path, meta.len(), depth));
            }
        }
    }

    let game = squash(game_name);
    let game_initials = initials(game_name);
    let candidates: Vec<(PathBuf, u64, i32)> = exes
        .into_iter()
        .filter_map(|(p, size, depth)| {
            let stem = squash(&p.file_stem()?.to_string_lossy());
            if stem.is_empty() || NOT_THE_GAME.iter().any(|bad| stem.contains(bad)) {
                return None;
            }
            let base = stem.trim_end_matches("win64shipping").trim_end_matches("shipping").trim_end_matches("x64");
            let mut score = 0;
            if !base.is_empty() && (base == game || game.contains(base) || base.contains(&game)) {
                score += 100;
            } else if game_initials.len() >= 2 && (base == game_initials || base.starts_with(&game_initials)) {
                score += 80;
            }
            let path_lower = p.to_string_lossy().to_lowercase();
            if path_lower.contains("win64") || path_lower.contains("x64") {
                score += 10;
            }
            score -= depth as i32; // shallower is likelier the real entry point
            Some((p, size, score))
        })
        .collect();

    let named = candidates.iter().filter(|c| c.2 >= 50).max_by_key(|c| (c.2, c.1));
    named
        .or_else(|| candidates.iter().max_by_key(|c| c.1))
        .map(|c| c.0.clone())
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

/// Launch an installed Steam game by app id: run its own .exe, or ask Steam
/// to launch it when no .exe can be found. Only ids of installed games are
/// accepted, and only files inside that game's install folder are run.
#[tauri::command]
pub fn launch_game(id: String) -> BevResult<String> {
    if id.is_empty() || id.len() > 12 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(BevError::Invalid("game id must be a Steam app number".into()));
    }
    let root = steam_root().ok_or_else(|| BevError::NotFound("Steam isn't installed".into()))?;
    let game = steam_games_in(&root)
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| BevError::NotFound(format!("no installed Steam game with id {id}")))?;

    if let Some(exe) = game.install_dir.as_deref().and_then(|d| find_main_exe(d, &game.name)) {
        return run_exe(&exe).map(|_| {
            format!("launched {} ({})", game.name, exe.file_name().unwrap_or_default().to_string_lossy())
        });
    }
    open_steam_url(&id).map(|_| format!("asked Steam to launch {}", game.name))
}

fn run_exe(exe: &Path) -> BevResult<()> {
    #[cfg(windows)]
    {
        // Run from the game's folder: many games load files relative to it.
        std::process::Command::new(exe)
            .current_dir(exe.parent().unwrap_or(exe))
            .spawn()
            .map(|_| ())
            .map_err(|e| BevError::Os(format!("couldn't start {}: {e}", exe.display())))
    }
    #[cfg(not(windows))]
    {
        let _ = exe;
        Err(BevError::Unsupported("game launch is Windows-only".into()))
    }
}

fn open_steam_url(id: &str) -> BevResult<()> {
    let url = format!("steam://rungameid/{id}");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let status = std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
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
            Some(Game {
                id: "252950".into(),
                name: "Rocket League".into(),
                source: "steam",
                install_dir: Some(PathBuf::from("rocketleague")),
            })
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

        let games = steam_games_in(&main);
        let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, vec!["Counter-Strike 2", "Rocket League"]);
        // installdir resolves against the library the manifest was found in.
        assert_eq!(games[1].install_dir, Some(main.join("steamapps").join("common").join("rocketleague")));
        std::fs::remove_dir_all(&base).ok();
    }

    fn touch(path: &Path, bytes: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![0u8; bytes]).unwrap();
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bev-exe-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        d
    }

    #[test]
    fn finds_rocket_league_exe_among_helpers() {
        let d = temp("rl");
        touch(&d.join("Binaries/Win64/RocketLeague.exe"), 9000);
        touch(&d.join("Binaries/Win64/EasyAntiCheat_EOS_Setup.exe"), 20000);
        touch(&d.join("Engine/Binaries/Win64/CrashReportClient.exe"), 30000);
        touch(&d.join("_CommonRedist/vcredist/2019/VC_redist.x64.exe"), 40000);
        let exe = find_main_exe(&d, "Rocket League").unwrap();
        assert!(exe.ends_with("Binaries/Win64/RocketLeague.exe"), "{exe:?}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn matches_exes_named_by_initials_or_shipping_suffix() {
        let d = temp("cs2");
        touch(&d.join("game/bin/win64/cs2.exe"), 500);
        touch(&d.join("game/bin/win64/gameoverlayui.exe"), 9000);
        assert!(find_main_exe(&d, "Counter-Strike 2").unwrap().ends_with("cs2.exe"));
        std::fs::remove_dir_all(&d).ok();

        let d = temp("ue");
        touch(&d.join("Acme.exe"), 200); // small bootstrap
        touch(&d.join("Acme/Binaries/Win64/AcmeGame-Win64-Shipping.exe"), 9000);
        let exe = find_main_exe(&d, "Acme Game").unwrap();
        assert!(exe.ends_with("AcmeGame-Win64-Shipping.exe"), "{exe:?}");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn falls_back_to_the_largest_exe_without_a_name_match() {
        let d = temp("odd");
        touch(&d.join("start.exe"), 100);
        touch(&d.join("bin/engine64.exe"), 8000);
        touch(&d.join("bin/unins000.exe"), 99999);
        assert!(find_main_exe(&d, "Something Else").unwrap().ends_with("engine64.exe"));
        std::fs::remove_dir_all(&d).ok();

        // Helper filters must not catch real names ("Reach" contains "eac").
        let d = temp("reach");
        touch(&d.join("haloreach.exe"), 100);
        touch(&d.join("mcclauncher.exe"), 9000);
        assert!(find_main_exe(&d, "Halo Reach").unwrap().ends_with("haloreach.exe"));
        assert_eq!(find_main_exe(&temp("missing"), "Nothing"), None);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn launch_rejects_anything_but_digits() {
        for bad in ["", "252950 & calc", "abc", "1234567890123"] {
            assert!(launch_game(bad.into()).is_err(), "{bad:?} should be rejected");
        }
    }
}
