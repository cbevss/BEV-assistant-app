//! App engine tests: merge of discovery data, resolution, launch planning.
use super::launchplan::{plan, LaunchPlan, multi_instance};
use super::model::*;
use super::resolve::*;

/// A realistic slice of what the discovery scan returns on Windows 11.
/// (Package family names are illustrative.)
const FIXTURE: &str = r#"{
  "start": [
    {"Name": "Antimicro", "AppID": "Antimicro.Antimicro_abc123xyz!App"},
    {"Name": "Spotify", "AppID": "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"},
    {"Name": "Visual Studio Code", "AppID": "{6D809377-6AF0-444B-8957-A3773F02200E}\\Microsoft VS Code\\Code.exe"},
    {"Name": "Google Chrome", "AppID": "Chrome"},
    {"Name": "Discord", "AppID": "com.squirrel.Discord.Discord"},
    {"Name": "Microsoft Edge", "AppID": "MSEdge"},
    {"Name": "OBS Studio (64bit)", "AppID": "{6D809377-6AF0-444B-8957-A3773F02200E}\\obs-studio\\bin\\64bit\\obs64.exe"},
    {"Name": "Uninstall OBS Studio", "AppID": "{6D809377-6AF0-444B-8957-A3773F02200E}\\obs-studio\\uninstall.exe"},
    {"Name": "Notepad", "AppID": "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App"},
    {"Name": "Calculator", "AppID": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"},
    {"Name": "Microsoft Teams", "AppID": "MSTeams_8wekyb3d8bbwe!MSTeams"},
    {"Name": "Teams Machine-Wide Installer", "AppID": "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Teams Installer\\Teams.exe"},
    {"Name": "Steam", "AppID": "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Steam\\steam.exe"},
    {"Name": "Terminal", "AppID": "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"}
  ],
  "packages": [
    {"family": "Antimicro.Antimicro_abc123xyz", "location": "C:\\Program Files\\WindowsApps\\Antimicro.Antimicro_3.0.0.0_x64__abc123xyz", "apps": {"id": "App", "exe": "bin/antimicro.exe"}},
    {"family": "SpotifyAB.SpotifyMusic_zpdnekdrzrea0", "location": "C:\\Program Files\\WindowsApps\\SpotifyAB.SpotifyMusic_1.2_x64__zpdnekdrzrea0", "apps": [{"id": "Spotify", "exe": "Spotify.exe"}]},
    {"family": "Microsoft.WindowsNotepad_8wekyb3d8bbwe", "location": "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11", "apps": [{"id": "App", "exe": "Notepad\\Notepad.exe"}]}
  ],
  "shortcuts": [
    {"name": "Google Chrome", "path": "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk", "target": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "args": ""},
    {"name": "Discord", "path": "C:\\Users\\cbevs\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Discord Inc\\Discord.lnk", "target": "C:\\Users\\cbevs\\AppData\\Local\\Discord\\Update.exe", "args": "--processStart Discord.exe"},
    {"name": "Rocket League Tracker", "path": "C:\\Users\\cbevs\\Desktop\\Rocket League Tracker.lnk", "target": "C:\\Tools\\RLTracker\\rltracker.exe", "args": ""},
    {"name": "Uninstall Tracker", "path": "C:\\Users\\cbevs\\Desktop\\Uninstall Tracker.lnk", "target": "C:\\Tools\\RLTracker\\unins000.exe", "args": ""}
  ],
  "appPaths": [
    {"exe": "chrome.exe", "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"},
    {"exe": "wordpad.exe", "path": "C:\\Program Files\\Windows NT\\Accessories\\wordpad.exe"},
    {"exe": "msedge.exe", "path": "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"}
  ],
  "folders": {"ProgramFiles": "C:\\Program Files", "ProgramFilesX86": "C:\\Program Files (x86)"},
  "defaults": {
    "browser": {"command": "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\" --single-argument %1"},
    "music": {"aumid": "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"}
  }
}"#;

fn index() -> AppIndex {
    let raw: RawDiscovery = serde_json::from_str(FIXTURE).unwrap();
    merge(&raw, 1)
}

fn found(q: &str) -> AppRecord {
    match resolve(q, &index().apps) {
        Resolution::Found { app, .. } => app,
        other => panic!("{q}: expected Found, got {other:?}"),
    }
}

#[test]
fn merge_builds_store_app_records() {
    let idx = index();
    let a = idx.apps.iter().find(|a| a.name == "Antimicro").unwrap();
    assert_eq!(a.kind, AppKind::Packaged);
    assert_eq!(a.app_id.as_deref(), Some("Antimicro.Antimicro_abc123xyz!App"));
    assert_eq!(a.family.as_deref(), Some("Antimicro.Antimicro_abc123xyz"));
    // Single-object "apps" (PowerShell's one-item quirk) still parses; / becomes \.
    assert_eq!(a.exe_path.as_deref(), Some("C:\\Program Files\\WindowsApps\\Antimicro.Antimicro_3.0.0.0_x64__abc123xyz\\bin\\antimicro.exe"));
    assert_eq!(a.exe_name.as_deref(), Some("antimicro.exe"));
}

#[test]
fn merge_resolves_known_folder_paths_and_shortcuts() {
    let idx = index();
    let code = idx.apps.iter().find(|a| a.name == "Visual Studio Code").unwrap();
    assert_eq!(code.exe_path.as_deref(), Some("C:\\Program Files\\Microsoft VS Code\\Code.exe"));
    let chrome = idx.apps.iter().find(|a| a.name == "Google Chrome").unwrap();
    assert_eq!(chrome.exe_name.as_deref(), Some("chrome.exe"));
    assert!(chrome.shortcut.is_some());
    let discord = idx.apps.iter().find(|a| a.name == "Discord").unwrap();
    assert_eq!(discord.exe_name.as_deref(), Some("Discord.exe"), "Squirrel --processStart");
    assert!(idx.apps.iter().any(|a| a.name == "Rocket League Tracker" && a.source == "shortcut"));
}

#[test]
fn merge_drops_uninstallers_and_dupes() {
    let idx = index();
    assert!(!idx.apps.iter().any(|a| a.name.to_lowercase().contains("uninstall")));
    // chrome.exe from App Paths is the same app as the Start entry.
    assert_eq!(idx.apps.iter().filter(|a| a.exe_name.as_deref() == Some("chrome.exe")).count(), 1);
    assert!(idx.apps.iter().any(|a| a.name == "wordpad" && a.source == "apppaths"));
    assert!(idx.apps.iter().any(|a| a.name == "Device Manager" && a.kind == AppKind::System));
}

#[test]
fn resolves_by_name_alias_and_typo() {
    assert_eq!(found("AntiMicro").name, "Antimicro");
    assert_eq!(found("anti micro").name, "Antimicro");
    assert_eq!(found("9N1FCFQ6P5LW").name, "Antimicro");
    assert_eq!(found("spotify").name, "Spotify");
    assert_eq!(found("spotfy").name, "Spotify");
    assert_eq!(found("vs code").name, "Visual Studio Code");
    assert_eq!(found("visual studio").name, "Visual Studio Code");
    assert_eq!(found("chrome").name, "Google Chrome");
    assert_eq!(found("obs").name, "OBS Studio (64bit)");
    assert_eq!(found("the calculator app").name, "Calculator");
    assert_eq!(found("Task Manager").name, "Task Manager");
    assert_eq!(found("device manager").name, "Device Manager");
    assert_eq!(found("file explorer").name, "File Explorer");
}

#[test]
fn default_browser_and_music_player() {
    assert_eq!(found("my browser").name, "Google Chrome");
    assert_eq!(found("browser").name, "Google Chrome");
    assert_eq!(found("music player").name, "Spotify");
}

#[test]
fn ambiguous_names_ask() {
    match resolve("teams", &index().apps) {
        Resolution::Ambiguous { options } => {
            let names: Vec<_> = options.iter().map(|o| o.app.name.as_str()).collect();
            assert!(names.contains(&"Microsoft Teams") && names.contains(&"Teams Machine-Wide Installer"), "{names:?}");
        }
        other => panic!("expected Ambiguous, got {other:?}"),
    }
}

#[test]
fn not_installed() {
    assert!(matches!(resolve("photoshop", &index().apps), Resolution::NotFound { .. }));
    assert!(matches!(resolve("zz", &index().apps), Resolution::NotFound { .. }));
    assert_eq!(store_link("antimicro").as_deref(), Some("https://apps.microsoft.com/detail/9N1FCFQ6P5LW"));
    assert_eq!(store_link("photoshop"), None);
}

#[test]
fn launch_plans_by_app_type() {
    let idx = index();
    let get = |n: &str| idx.apps.iter().find(|a| a.name == n).unwrap().clone();
    assert_eq!(plan(&get("Antimicro")).unwrap(), LaunchPlan::Activate { aumid: "Antimicro.Antimicro_abc123xyz!App".into() });
    assert_eq!(plan(&get("Google Chrome")).unwrap(), LaunchPlan::Shell { file: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk".into(), dir: None });
    assert_eq!(
        plan(&get("Visual Studio Code")).unwrap(),
        LaunchPlan::Shell { file: "C:\\Program Files\\Microsoft VS Code\\Code.exe".into(), dir: Some("C:\\Program Files\\Microsoft VS Code".into()) }
    );
    assert_eq!(plan(&get("Microsoft Edge")).unwrap(), LaunchPlan::AppsFolder { app_id: "MSEdge".into() });
    assert_eq!(plan(&get("Device Manager")).unwrap(), LaunchPlan::Shell { file: "devmgmt.msc".into(), dir: None });
    assert!(multi_instance(&get("File Explorer")));
    assert!(!multi_instance(&get("Spotify")));
}

#[test]
fn rejects_unsafe_appsfolder_ids() {
    let mut r = index().apps.into_iter().find(|a| a.name == "Microsoft Edge").unwrap();
    r.app_id = Some("MSEdge\" & calc".into());
    assert!(plan(&r).is_err());
}

#[test]
fn helpers() {
    assert_eq!(command_exe("\"C:\\a b\\x.exe\" %1").as_deref(), Some("C:\\a b\\x.exe"));
    assert_eq!(command_exe("C:\\x\\y.exe --flag").as_deref(), Some("C:\\x\\y.exe"));
    assert!(is_junk("Uninstall Foo") && is_junk("Foo Help") && !is_junk("Helpdesk Pro"));
    assert_eq!(normalise("The Spotify App"), "spotify");
}

// ---- engine flows (scanner and launcher faked) ----
use super::engine::{AppEngine, OpenResult};
use super::launch::{title_matches, title_words, window_belongs, LaunchOutcome};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bev-appengine-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

#[test]
fn engine_scans_once_then_persists() {
    let dir = tmpdir("persist");
    let scans = Arc::new(AtomicUsize::new(0));
    let s2 = scans.clone();
    let e = AppEngine::with_fakes(
        dir.clone(),
        move |_| {
            s2.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::from_str(FIXTURE).unwrap())
        },
        |a, _| LaunchOutcome::Opened { window: format!("{} window", a.name), pid: Some(1) },
    );
    assert_eq!(e.open("antimicro").unwrap(), OpenResult::Opened { app: "Antimicro".into(), window: "Antimicro window".into() });
    e.open("spotify").unwrap();
    assert_eq!(scans.load(Ordering::SeqCst), 1, "index reused, not rescanned per request");
    // A restart loads the saved index without scanning.
    let e2 = AppEngine::with_fakes(dir, |_| Err("should not scan".into()), |_, _| LaunchOutcome::Opened { window: "w".into(), pid: None });
    assert!(e2.status().count > 10);
    assert!(matches!(e2.open("vs code").unwrap(), OpenResult::Opened { .. }));
}

#[test]
fn engine_finds_newly_installed_app_on_miss() {
    let dir = tmpdir("newapp");
    let calls = Arc::new(AtomicUsize::new(0));
    let c2 = calls.clone();
    let e = AppEngine::with_fakes(
        dir,
        move |_| {
            let n = c2.fetch_add(1, Ordering::SeqCst);
            let mut raw: RawDiscovery = serde_json::from_str(FIXTURE).unwrap();
            if n > 0 {
                raw.start.push(RawStart { name: Some("Blender".into()), app_id: Some("{6D809377-6AF0-444B-8957-A3773F02200E}\\Blender Foundation\\Blender\\blender.exe".into()) });
            }
            Ok(raw)
        },
        |_, _| LaunchOutcome::Opened { window: "Blender".into(), pid: Some(7) },
    );
    e.open("spotify").unwrap(); // scan #1: no Blender yet
    // The user installs Blender; "open blender" misses, rescans (#2), finds it.
    assert!(matches!(e.open("blender").unwrap(), OpenResult::Opened { .. }));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn engine_reports_not_installed_ambiguous_and_failures_honestly() {
    let e = AppEngine::with_fakes(tmpdir("honest"), |_| Ok(serde_json::from_str(FIXTURE).unwrap()), |a, _| {
        if a.name == "Spotify" {
            LaunchOutcome::Failed { error: "Windows couldn't activate the app".into() }
        } else {
            LaunchOutcome::Unverified { detail: "no window appeared".into() }
        }
    });
    match e.open("photoshop").unwrap() {
        OpenResult::NotInstalled { store_url, .. } => assert_eq!(store_url, None),
        r => panic!("{r:?}"),
    }
    assert!(matches!(e.open("teams").unwrap(), OpenResult::Ambiguous { .. }));
    assert_eq!(e.open("spotify").unwrap(), OpenResult::Failed { app: "Spotify".into(), error: "Windows couldn't activate the app".into() });
    assert!(matches!(e.open("calculator").unwrap(), OpenResult::Unverified { .. }));
    assert!(e.open("  ").is_err());
}

#[test]
fn engine_not_installed_offers_store_page() {
    let mut raw: RawDiscovery = serde_json::from_str(FIXTURE).unwrap();
    raw.start.retain(|s| s.name.as_deref() != Some("Antimicro"));
    let raw = Arc::new(std::sync::Mutex::new(Some(raw)));
    let e = AppEngine::with_fakes(tmpdir("store"), move |_| Ok(raw.lock().unwrap().take().unwrap_or_default()), |_, _| LaunchOutcome::Opened { window: "w".into(), pid: None });
    match e.open("antimicro").unwrap() {
        OpenResult::NotInstalled { store_url, .. } => assert_eq!(store_url.as_deref(), Some("https://apps.microsoft.com/detail/9N1FCFQ6P5LW")),
        r => panic!("{r:?}"),
    }
}

#[test]
fn window_matching_for_verification() {
    let idx = index();
    let get = |n: &str| idx.apps.iter().find(|a| a.name == n).unwrap().clone();
    let spotify = get("Spotify");
    assert!(window_belongs(&spotify, Some("C:\\Program Files\\WindowsApps\\SpotifyAB\\Spotify.exe"), "Artist - Song"));
    assert!(!window_belongs(&spotify, Some("C:\\Windows\\notepad.exe"), "Spotify notes.txt - Notepad"));
    // Store app hosted by ApplicationFrameHost: matched by title.
    let calc = get("Calculator");
    assert!(window_belongs(&calc, Some("C:\\Windows\\System32\\ApplicationFrameHost.exe"), "Calculator"));
    assert!(!window_belongs(&calc, Some("C:\\Windows\\System32\\ApplicationFrameHost.exe"), "Photos"));
    assert!(window_belongs(&get("Settings"), Some("C:\\Windows\\System32\\ApplicationFrameHost.exe"), "Settings"));
    assert_eq!(title_words("Google Chrome"), vec!["chrome"]);
    assert!(title_matches("New Tab - Google Chrome", &title_words("Google Chrome")));
    assert!(!title_matches("Chromebook deals - Edge", &title_words("Google Chrome")));
}
