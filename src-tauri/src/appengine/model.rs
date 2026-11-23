//! Application records and the merge that turns raw discovery data (Start
//! apps, Store packages, shortcuts, App Paths, defaults) into one index.
//! Pure logic: no Windows calls, so it's unit-tested on any platform.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    /// Microsoft Store / MSIX app, activated by its AppUserModelID.
    Packaged,
    /// Conventional desktop app (exe, shortcut, or Start-menu AppID).
    Win32,
    /// Built-in Windows tool or settings page.
    System,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AppRecord {
    /// Stable key: the AppUserModelID for Start apps, else a path-based id.
    pub id: String,
    pub name: String,
    pub kind: AppKind,
    /// Start-menu AppID (AUMID for packaged apps).
    pub app_id: Option<String>,
    /// Package family name (packaged apps).
    pub family: Option<String>,
    pub exe_path: Option<String>,
    /// Process image name used to verify launches, e.g. "Spotify.exe".
    pub exe_name: Option<String>,
    pub shortcut: Option<String>,
    /// URI or shell target for built-ins (e.g. "ms-settings:", "devmgmt.msc").
    pub uri: Option<String>,
    pub install_dir: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppIndex {
    /// Epoch ms of the scan.
    pub scanned_at: i64,
    pub apps: Vec<AppRecord>,
}

// ---- raw discovery output (from the PowerShell scan) ----

fn one_or_many<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany<T> {
        Many(Vec<T>),
        One(T),
        None,
    }
    Ok(match Option::<OneOrMany<T>>::deserialize(d)? {
        Some(OneOrMany::Many(v)) => v,
        Some(OneOrMany::One(t)) => vec![t],
        _ => Vec::new(),
    })
}

#[derive(Deserialize, Debug, Default)]
pub struct RawDiscovery {
    #[serde(default, deserialize_with = "one_or_many")]
    pub start: Vec<RawStart>,
    #[serde(default, deserialize_with = "one_or_many")]
    pub packages: Vec<RawPackage>,
    #[serde(default, deserialize_with = "one_or_many")]
    pub shortcuts: Vec<RawShortcut>,
    #[serde(default, rename = "appPaths", deserialize_with = "one_or_many")]
    pub app_paths: Vec<RawAppPath>,
    #[serde(default)]
    pub folders: HashMap<String, String>,
    #[serde(default)]
    pub defaults: HashMap<String, RawDefault>,
    /// Ready-made records from a native scan (Linux .desktop entries).
    #[serde(skip)]
    pub native: Vec<AppRecord>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RawStart {
    #[serde(rename = "Name")]
    pub name: Option<String>,
    #[serde(rename = "AppID")]
    pub app_id: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RawPackage {
    pub family: String,
    pub location: Option<String>,
    #[serde(default, deserialize_with = "one_or_many")]
    pub apps: Vec<RawPackageApp>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RawPackageApp {
    pub id: Option<String>,
    pub exe: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RawShortcut {
    pub name: String,
    pub path: String,
    pub target: Option<String>,
    pub args: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RawAppPath {
    pub exe: String,
    pub path: String,
}

/// Default handler for a protocol / file type: an exe command or a Store AUMID.
#[derive(Deserialize, Debug, Clone, Default)]
pub struct RawDefault {
    pub command: Option<String>,
    pub aumid: Option<String>,
}

/// Entries nobody asks BEV to open (uninstallers, readmes, help pages).
pub fn is_junk(name: &str) -> bool {
    let n = name.to_lowercase();
    const JUNK: &[&str] = &[
        "uninstall", "uninstaller", "readme", "read me", "release notes", "license", "licence", "documentation",
        "user guide", "user manual", "website", "web site", "support center", "eula", "what's new", "changelog",
    ];
    JUNK.iter().any(|j| n.contains(j)) || n.ends_with(" help") || n == "help" || n.starts_with("remove ")
}

pub fn file_name(path: &str) -> Option<String> {
    path.rsplit(['\\', '/']).next().filter(|s| !s.is_empty()).map(|s| s.to_string())
}

fn parent_dir(path: &str) -> Option<String> {
    let i = path.rfind(['\\', '/'])?;
    (i > 0).then(|| path[..i].to_string())
}

/// Known-folder GUIDs Windows uses in Start-menu AppIDs for desktop apps,
/// mapped to the folder names the scan reports.
const KNOWN_FOLDERS: &[(&str, &str)] = &[
    ("{6D809377-6AF0-444B-8957-A3773F02200E}", "ProgramFiles"),
    ("{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}", "ProgramFilesX86"),
    ("{F38BF404-1D43-42F2-9305-67DE0B28FC23}", "Windows"),
    ("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}", "System"),
    ("{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}", "SystemX86"),
    ("{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}", "LocalAppData"),
    ("{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}", "AppData"),
    ("{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}", "ProgramData"),
];

/// "{GUID}\Vendor\app.exe" or "C:\...\app.exe" → absolute exe path.
pub fn app_id_to_path(app_id: &str, folders: &HashMap<String, String>) -> Option<String> {
    let lower = app_id.to_lowercase();
    if !lower.ends_with(".exe") {
        return None;
    }
    if app_id.len() > 2 && app_id.as_bytes()[1] == b':' {
        return Some(app_id.to_string());
    }
    for (guid, folder) in KNOWN_FOLDERS {
        if app_id.len() > guid.len() && app_id[..guid.len()].eq_ignore_ascii_case(guid) {
            let base = folders.get(*folder)?;
            let rest = app_id[guid.len()..].trim_start_matches(['\\', '/']);
            return Some(format!("{}\\{}", base.trim_end_matches('\\'), rest));
        }
    }
    None
}

/// The process a shortcut really starts. Squirrel-installed apps (Discord,
/// Teams classic, Slack…) point at Update.exe with `--processStart App.exe`.
pub fn shortcut_exe_name(target: &str, args: Option<&str>) -> Option<String> {
    let name = file_name(target)?;
    if name.eq_ignore_ascii_case("update.exe") {
        if let Some(a) = args {
            let mut it = a.split_whitespace();
            while let Some(tok) = it.next() {
                if tok.eq_ignore_ascii_case("--processStart") {
                    return it.next().map(|s| s.trim_matches('"').to_string());
                }
            }
        }
    }
    name.to_lowercase().ends_with(".exe").then_some(name)
}

/// Built-in Windows tools, so "open Device Manager" works without a scan hit.
pub fn builtins() -> Vec<AppRecord> {
    let sys = |name: &str, target: &str, exe: Option<&str>, aliases: &[&str]| AppRecord {
        id: format!("sys:{}", name.to_lowercase()),
        name: name.to_string(),
        kind: AppKind::System,
        app_id: None,
        family: None,
        exe_path: None,
        exe_name: exe.map(str::to_string),
        shortcut: None,
        uri: Some(target.to_string()),
        install_dir: None,
        aliases: aliases.iter().map(|s| s.to_string()).collect(),
        source: "builtin".into(),
    };
    vec![
        sys("Settings", "ms-settings:", Some("SystemSettings.exe"), &["windows settings", "pc settings"]),
        sys("Task Manager", "taskmgr.exe", Some("Taskmgr.exe"), &["taskmgr"]),
        sys("Device Manager", "devmgmt.msc", None, &["devices manager"]),
        sys("Control Panel", "control.exe", None, &["control"]),
        sys("File Explorer", "explorer.exe", Some("explorer.exe"), &["explorer", "files", "my files", "file manager", "windows explorer"]),
        sys("Event Viewer", "eventvwr.msc", None, &["event logs", "windows logs"]),
        sys("Services", "services.msc", None, &["windows services"]),
        sys("Command Prompt", "cmd.exe", Some("cmd.exe"), &["cmd"]),
        sys("Windows PowerShell", "powershell.exe", Some("powershell.exe"), &["powershell"]),
        sys("Resource Monitor", "resmon.exe", None, &["resmon"]),
        sys("System Information", "msinfo32.exe", Some("msinfo32.exe"), &["msinfo", "system info"]),
        sys("Sound settings", "ms-settings:sound", Some("SystemSettings.exe"), &["sound", "audio settings"]),
        sys("Sound control panel", "mmsys.cpl", None, &["recording devices", "playback devices", "mmsys"]),
        sys("Display settings", "ms-settings:display", Some("SystemSettings.exe"), &["display"]),
        sys("Bluetooth settings", "ms-settings:bluetooth", Some("SystemSettings.exe"), &["bluetooth"]),
        sys("Network settings", "ms-settings:network-status", Some("SystemSettings.exe"), &["network", "wifi settings", "wi-fi settings"]),
        sys("Windows Update", "ms-settings:windowsupdate", Some("SystemSettings.exe"), &["updates", "check for updates"]),
        sys("Apps & features", "ms-settings:appsfeatures", Some("SystemSettings.exe"), &["installed apps", "add or remove programs", "programs and features"]),
        sys("Disk Management", "diskmgmt.msc", None, &["disk manager", "partitions"]),
        sys("Registry Editor", "regedit.exe", Some("regedit.exe"), &["regedit", "registry"]),
    ]
}

fn defaults_aliases(kind: &str) -> &'static [&'static str] {
    match kind {
        "browser" => &["browser", "my browser", "web browser", "default browser", "internet", "the internet"],
        "music" => &["music player", "my music player", "default music player", "music app"],
        _ => &[],
    }
}

/// Merge raw discovery into deduplicated records.
pub fn merge(raw: &RawDiscovery, scanned_at: i64) -> AppIndex {
    let packages: HashMap<String, &RawPackage> =
        raw.packages.iter().map(|p| (p.family.to_lowercase(), p)).collect();

    // Shortcuts by name (Start menu first, they're listed first by the scan).
    let mut shortcut_by_name: HashMap<String, &RawShortcut> = HashMap::new();
    for s in &raw.shortcuts {
        if is_junk(&s.name) {
            continue;
        }
        shortcut_by_name.entry(s.name.to_lowercase()).or_insert(s);
    }
    let mut used_shortcuts: HashSet<String> = HashSet::new();
    let mut apps: Vec<AppRecord> = raw.native.clone();

    for s in &raw.start {
        let (Some(name), Some(app_id)) = (s.name.as_deref(), s.app_id.as_deref()) else { continue };
        let name = name.trim();
        if name.is_empty() || is_junk(name) {
            continue;
        }
        if let Some((family, app)) = app_id.split_once('!') {
            let pkg = packages.get(&family.to_lowercase());
            let exe_rel = pkg.and_then(|p| {
                p.apps.iter().find(|a| a.id.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(app))).and_then(|a| a.exe.clone())
            });
            let location = pkg.and_then(|p| p.location.clone());
            let exe_path = match (&location, &exe_rel) {
                (Some(l), Some(e)) => Some(format!("{}\\{}", l.trim_end_matches('\\'), e.replace('/', "\\"))),
                _ => None,
            };
            apps.push(AppRecord {
                id: app_id.to_string(),
                name: name.to_string(),
                kind: AppKind::Packaged,
                app_id: Some(app_id.to_string()),
                family: Some(family.to_string()),
                exe_name: exe_path.as_deref().and_then(file_name),
                exe_path,
                shortcut: None,
                uri: None,
                install_dir: location,
                aliases: Vec::new(),
                source: "start".into(),
            });
            continue;
        }
        let lnk = shortcut_by_name.get(&name.to_lowercase()).copied();
        if let Some(l) = lnk {
            used_shortcuts.insert(l.path.to_lowercase());
        }
        let exe_path = app_id_to_path(app_id, &raw.folders)
            .or_else(|| lnk.and_then(|l| l.target.clone()).filter(|t| t.to_lowercase().ends_with(".exe")));
        let exe_name = lnk
            .and_then(|l| l.target.as_deref().and_then(|t| shortcut_exe_name(t, l.args.as_deref())))
            .or_else(|| exe_path.as_deref().and_then(file_name));
        apps.push(AppRecord {
            id: format!("app:{}", app_id.to_lowercase()),
            name: name.to_string(),
            kind: AppKind::Win32,
            app_id: Some(app_id.to_string()),
            family: None,
            install_dir: exe_path.as_deref().and_then(parent_dir),
            exe_path,
            exe_name,
            shortcut: lnk.map(|l| l.path.clone()),
            uri: None,
            aliases: Vec::new(),
            source: "start".into(),
        });
    }

    // Desktop / Start Menu shortcuts that Get-StartApps didn't list.
    for s in &raw.shortcuts {
        if is_junk(&s.name) || used_shortcuts.contains(&s.path.to_lowercase()) {
            continue;
        }
        let Some(target) = s.target.as_deref() else { continue };
        let Some(exe_name) = shortcut_exe_name(target, s.args.as_deref()) else { continue };
        if exe_name.to_lowercase().starts_with("unins") {
            continue;
        }
        apps.push(AppRecord {
            id: format!("lnk:{}", s.path.to_lowercase()),
            name: s.name.clone(),
            kind: AppKind::Win32,
            app_id: None,
            family: None,
            exe_path: Some(target.to_string()),
            exe_name: Some(exe_name),
            shortcut: Some(s.path.clone()),
            uri: None,
            install_dir: parent_dir(target),
            aliases: Vec::new(),
            source: "shortcut".into(),
        });
    }

    // App Paths: registered exes ("wordpad.exe" → path) not already known.
    for p in &raw.app_paths {
        let exe = p.exe.trim();
        if !exe.to_lowercase().ends_with(".exe") {
            continue;
        }
        let known = apps.iter().any(|a| a.exe_name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(exe)));
        if known {
            // Fill a missing path on the record that has this exe.
            if let Some(a) = apps.iter_mut().find(|a| a.exe_path.is_none() && a.exe_name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(exe))) {
                a.exe_path = Some(p.path.clone());
            }
            continue;
        }
        let stem = exe[..exe.len() - 4].to_string();
        apps.push(AppRecord {
            id: format!("exe:{}", exe.to_lowercase()),
            name: stem,
            kind: AppKind::Win32,
            app_id: None,
            family: None,
            exe_path: Some(p.path.clone()),
            exe_name: Some(exe.to_string()),
            shortcut: None,
            uri: None,
            install_dir: parent_dir(&p.path),
            aliases: Vec::new(),
            source: "apppaths".into(),
        });
    }

    // Windows tools and settings pages; on Linux they come from .desktop files.
    let builtin = if cfg!(target_os = "linux") && !raw.native.is_empty() { Vec::new() } else { builtins() };
    for b in builtin {
        let dup = apps.iter().any(|a| a.name.eq_ignore_ascii_case(&b.name));
        if !dup {
            apps.push(b);
        }
    }

    // Dedupe by id, keeping the first (Start apps come first).
    let mut seen = HashSet::new();
    apps.retain(|a| seen.insert(a.id.to_lowercase()));

    // Default browser / music player get friendly aliases.
    for (kind, d) in &raw.defaults {
        let aliases = defaults_aliases(kind);
        if aliases.is_empty() {
            continue;
        }
        let target = if let Some(aumid) = d.aumid.as_deref().filter(|s| !s.is_empty()) {
            apps.iter_mut().find(|a| a.app_id.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(aumid)))
        } else if let Some(exe) = d.command.as_deref().and_then(command_exe).and_then(|p| file_name(&p)) {
            apps.iter_mut().find(|a| a.exe_name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(&exe)))
        } else {
            None
        };
        if let Some(a) = target {
            a.aliases.extend(aliases.iter().map(|s| s.to_string()));
        }
    }

    AppIndex { scanned_at, apps }
}

/// The exe path out of a shell command line: `"C:\x\chrome.exe" --single-argument %1`.
pub fn command_exe(cmd: &str) -> Option<String> {
    let c = cmd.trim();
    if let Some(rest) = c.strip_prefix('"') {
        return rest.split('"').next().map(str::to_string).filter(|s| !s.is_empty());
    }
    let lower = c.to_lowercase();
    let end = lower.find(".exe")? + 4;
    Some(c[..end].to_string())
}
