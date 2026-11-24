//! Game libraries across launchers, so BEV can download (install) a game the
//! user owns: Steam, Epic Games and GOG Galaxy. Everything is read from the
//! launchers' own files on this PC; nothing is sent anywhere. Downloads start
//! through each launcher's own install link, so the launcher shows its usual
//! install window (drive, size) and does the download on the user's account.

use crate::error::{BevError, BevResult};
use base64::Engine;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LibGame {
    /// Launcher-specific id: Steam app id, Epic "namespace:catalogId:appName", GOG release key.
    pub id: String,
    pub name: String,
    pub installed: bool,
}

#[derive(Debug, Default, Serialize)]
pub struct Libraries {
    pub steam: bool,
    pub epic: bool,
    pub gog: bool,
    /// Steam: app ids in the user's library that BEV can see locally (Steam keeps a folder per
    /// library game in appcache/librarycache, and played games in localconfig.vdf).
    pub steam_owned: Vec<String>,
    pub steam_installed: Vec<LibGame>,
    pub epic_games: Vec<LibGame>,
    pub gog_games: Vec<LibGame>,
    /// Other launchers that are installed (BEV can open them, but can't read their libraries).
    pub others: Vec<String>,
}

fn program_data() -> PathBuf {
    PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into()))
}

// ---------- Steam ----------
/// App ids from Steam's local files: library cache folders and localconfig.vdf apps. Pure-ish; tested.
pub(crate) fn steam_owned_ids(root: &Path) -> Vec<String> {
    let mut ids: BTreeSet<String> = BTreeSet::new();
    let digits = |s: &str| !s.is_empty() && s.len() <= 10 && s.bytes().all(|b| b.is_ascii_digit());
    if let Ok(d) = std::fs::read_dir(root.join("appcache").join("librarycache")) {
        for e in d.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            let id = n.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("").to_string();
            if digits(&id) {
                ids.insert(id);
            }
        }
    }
    if let Ok(users) = std::fs::read_dir(root.join("userdata")) {
        for u in users.flatten() {
            if let Ok(text) = std::fs::read_to_string(u.path().join("config").join("localconfig.vdf")) {
                ids.extend(localconfig_app_ids(&text));
            }
        }
    }
    ids.into_iter().collect()
}

/// App ids listed under "apps" in localconfig.vdf (keys that are numbers followed by "{"). Pure; tested.
pub(crate) fn localconfig_app_ids(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_apps = 0usize;
    let mut depth = 0usize;
    let mut pending: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        if t == "{" {
            depth += 1;
            if let Some(k) = pending.take() {
                if k.eq_ignore_ascii_case("apps") && in_apps == 0 {
                    in_apps = depth;
                } else if in_apps != 0 && depth == in_apps + 1 && !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()) {
                    out.push(k);
                }
            }
            continue;
        }
        if t == "}" {
            if in_apps == depth {
                in_apps = 0;
            }
            depth = depth.saturating_sub(1);
            continue;
        }
        pending = (t.starts_with('"') && t.ends_with('"') && t.matches('"').count() == 2).then(|| t.trim_matches('"').to_string());
    }
    out
}

// ---------- Epic ----------
/// Owned Epic games from catcache.bin (base64 JSON of the library's catalog items). Pure; tested.
pub(crate) fn epic_catalog(b64: &[u8], installed_apps: &BTreeSet<String>) -> Vec<LibGame> {
    let raw: Vec<u8> = b64.iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) else { return vec![] };
    let Ok(items) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return vec![] };
    let mut out: Vec<LibGame> = Vec::new();
    for it in items.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let is_game = it["categories"].as_array().is_some_and(|c| c.iter().any(|x| x["path"] == "games"));
        let is_addon = it["mainGameItem"].is_object() || it["categories"].as_array().is_some_and(|c| c.iter().any(|x| x["path"].as_str().is_some_and(|p| p.starts_with("addons"))));
        let (Some(ns), Some(cat), Some(title)) = (it["namespace"].as_str(), it["id"].as_str(), it["title"].as_str()) else { continue };
        let app = it["releaseInfo"].as_array().and_then(|r| r.first()).and_then(|r| r["appId"].as_str()).unwrap_or("");
        if !is_game || is_addon || app.is_empty() {
            continue;
        }
        let ok = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
        if !(ok(ns) && ok(cat) && ok(app)) {
            continue;
        }
        if out.iter().any(|g| g.id.ends_with(&format!(":{app}"))) {
            continue;
        }
        out.push(LibGame { id: format!("{ns}:{cat}:{app}"), name: title.to_string(), installed: installed_apps.contains(app) });
    }
    out
}

fn epic_installed(dir: &Path) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    if let Ok(d) = std::fs::read_dir(dir) {
        for e in d.flatten() {
            if e.path().extension().is_some_and(|x| x == "item") {
                if let Ok(v) = std::fs::read(e.path()).map(|b| serde_json::from_slice::<serde_json::Value>(&b)) {
                    if let Ok(v) = v {
                        if let Some(a) = v["AppName"].as_str() {
                            set.insert(a.to_string());
                        }
                    }
                }
            }
        }
    }
    set
}

// ---------- GOG Galaxy ----------
fn gog_library(db: &Path) -> Vec<LibGame> {
    let Ok(conn) = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return vec![];
    };
    let installed: BTreeSet<String> = conn
        .prepare("SELECT productId FROM InstalledBaseProducts")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, i64>(0)).map(|rows| rows.flatten().map(|id| format!("gog_{id}")).collect()))
        .unwrap_or_default();
    let sql = "SELECT lr.releaseKey, gp.value FROM LibraryReleases lr \
               JOIN GamePieces gp ON gp.releaseKey = lr.releaseKey \
               JOIN GamePieceTypes t ON t.id = gp.gamePieceTypeId \
               WHERE lr.releaseKey LIKE 'gog_%' AND t.type IN ('title', 'originalTitle') ORDER BY t.type DESC";
    let rows: Vec<(String, String)> = conn
        .prepare(sql)
        .and_then(|mut s| s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map(|rows| rows.flatten().collect()))
        .unwrap_or_default();
    let mut out: Vec<LibGame> = Vec::new();
    for (key, value) in rows {
        if out.iter().any(|g| g.id == key) || !key[4..].bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let title = serde_json::from_str::<serde_json::Value>(&value).ok().and_then(|v| v["title"].as_str().map(String::from));
        if let Some(t) = title {
            out.push(LibGame { installed: installed.contains(&key), id: key, name: t });
        }
    }
    out
}

/// Every launcher's library BEV can read.
#[tauri::command]
pub fn game_libraries() -> BevResult<Libraries> {
    let mut l = Libraries::default();
    if let Some(root) = crate::games::steam_root_pub() {
        l.steam = true;
        l.steam_owned = steam_owned_ids(&root);
        l.steam_installed = crate::games::steam_games_in(&root).into_iter().map(|g| LibGame { id: g.id, name: g.name, installed: true }).collect();
    }
    let epic = program_data().join("Epic").join("EpicGamesLauncher").join("Data");
    if epic.is_dir() {
        l.epic = true;
        let installed = epic_installed(&epic.join("Manifests"));
        if let Ok(b) = std::fs::read(epic.join("Catalog").join("catcache.bin")) {
            l.epic_games = epic_catalog(&b, &installed);
        }
    }
    let gog = program_data().join("GOG.com").join("Galaxy").join("storage").join("galaxy-2.0.db");
    if gog.is_file() {
        l.gog = true;
        l.gog_games = gog_library(&gog);
    }
    let pf86 = PathBuf::from(std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into()));
    let pf = PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into()));
    for (name, path) in [
        ("Ubisoft Connect", pf86.join("Ubisoft").join("Ubisoft Game Launcher")),
        ("EA app", pf.join("Electronic Arts").join("EA Desktop")),
        ("Battle.net", pf86.join("Battle.net")),
    ] {
        if path.is_dir() {
            l.others.push(name.into());
        }
    }
    Ok(l)
}

/// The install link for a game in a launcher, checked against the library first. Pure; tested.
pub(crate) fn install_url(launcher: &str, id: &str) -> BevResult<String> {
    let safe = |s: &str| !s.is_empty() && s.len() < 120 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b));
    if !safe(id) {
        return Err(BevError::Invalid("bad game id".into()));
    }
    match launcher {
        "steam" if id.bytes().all(|b| b.is_ascii_digit()) => Ok(format!("steam://install/{id}")),
        "epic" if id.split(':').count() == 3 => Ok(format!("com.epicgames.launcher://apps/{}?action=install&silent=false", id.replace(':', "%3A"))),
        "gog" if id.starts_with("gog_") => Ok(format!("goggalaxy://openGameView/{id}")),
        _ => Err(BevError::Invalid("unknown launcher or id".into())),
    }
}

/// Start downloading a game in its launcher. Steam: any app id (Steam shows its store page if it isn't owned);
/// Epic and GOG: only games in the library BEV just read.
#[tauri::command]
pub fn start_game_download(launcher: String, id: String) -> BevResult<String> {
    if launcher != "steam" {
        let libs = game_libraries()?;
        let list = if launcher == "epic" { &libs.epic_games } else { &libs.gog_games };
        if !list.iter().any(|g| g.id == id) {
            return Err(BevError::NotFound("that game isn't in your library there".into()));
        }
    }
    let url = install_url(&launcher, &id)?;
    crate::games::open_launcher_url(&url)?;
    Ok(format!("opened the install for {id} in {launcher}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_app_ids_from_localconfig() {
        let text = "\"UserLocalConfigStore\"\n{\n\t\"Software\"\n\t{\n\t\t\"Valve\"\n\t\t{\n\t\t\t\"Steam\"\n\t\t\t{\n\t\t\t\t\"apps\"\n\t\t\t\t{\n\t\t\t\t\t\"252950\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"LastPlayed\"\t\t\"1\"\n\t\t\t\t\t}\n\t\t\t\t\t\"730\"\n\t\t\t\t\t{\n\t\t\t\t\t\t\"cloud\"\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\"123\"\n\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n";
        assert_eq!(localconfig_app_ids(text), vec!["252950", "730"]);
    }

    #[test]
    fn reads_epic_library_skipping_addons() {
        let json = r#"[{"namespace":"fn","id":"4fe75bbc","title":"Fortnite","categories":[{"path":"games"}],"releaseInfo":[{"appId":"Fortnite"}]},
            {"namespace":"x","id":"dlc1","title":"Some DLC","categories":[{"path":"addons"}],"mainGameItem":{},"releaseInfo":[{"appId":"DLC"}]},
            {"namespace":"rl","id":"9773aa1a","title":"Rocket League","categories":[{"path":"games"}],"releaseInfo":[{"appId":"Sugar"}]}]"#;
        let b64 = base64::engine::general_purpose::STANDARD.encode(json);
        let installed: BTreeSet<String> = ["Sugar".to_string()].into();
        let games = epic_catalog(b64.as_bytes(), &installed);
        assert_eq!(games.len(), 2);
        assert_eq!(games[1], LibGame { id: "rl:9773aa1a:Sugar".into(), name: "Rocket League".into(), installed: true });
    }

    #[test]
    fn install_links_only_from_clean_ids() {
        assert_eq!(install_url("steam", "730").unwrap(), "steam://install/730");
        assert_eq!(install_url("epic", "rl:9773aa1a:Sugar").unwrap(), "com.epicgames.launcher://apps/rl%3A9773aa1a%3ASugar?action=install&silent=false");
        assert_eq!(install_url("gog", "gog_1207658924").unwrap(), "goggalaxy://openGameView/gog_1207658924");
        assert!(install_url("steam", "730&x").is_err());
        assert!(install_url("steam", "abc").is_err());
        assert!(install_url("cmd", "730").is_err());
    }
}
