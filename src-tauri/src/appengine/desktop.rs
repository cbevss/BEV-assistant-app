//! Linux app discovery and launching from freedesktop `.desktop` entries
//! (system packages, ~/.local, Flatpak and Snap exports). Parsing is pure
//! and unit-tested; scanning and launching are Linux-only.

use super::model::{AppKind, AppRecord};
use std::collections::HashMap;

/// The `[Desktop Entry]` group of a .desktop file, keys as written.
pub fn parse_entry(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut in_main = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_main = l == "[Desktop Entry]";
            continue;
        }
        if !in_main || l.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = l.split_once('=') {
            out.entry(k.trim().to_string()).or_insert_with(|| v.trim().to_string());
        }
    }
    out
}

/// Split an Exec line into argv, honouring double quotes and dropping
/// field codes (%f %U …). `%%` becomes a literal %.
pub fn exec_argv(exec: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            '\\' if quoted => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            ' ' | '\t' if !quoted => {
                if has || !cur.is_empty() {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            _ => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        args.push(cur);
    }
    args.into_iter()
        .filter_map(|a| {
            if a.len() == 2 && a.starts_with('%') && a != "%%" {
                None
            } else {
                Some(a.replace("%%", "%"))
            }
        })
        .collect()
}

/// The process name to look for once the app is running.
pub fn process_name(entry: &HashMap<String, String>, argv: &[String]) -> Option<String> {
    // Flatpak/Snap wrappers: the real process is named after the app.
    if let Some(id) = entry.get("X-Flatpak") {
        if let Some(cmd) = argv.iter().find_map(|a| a.strip_prefix("--command=")) {
            return std::path::Path::new(cmd).file_name().map(|n| n.to_string_lossy().into_owned());
        }
        return id.rsplit('.').next().map(str::to_lowercase);
    }
    if let Some(name) = entry.get("X-SnapInstanceName") {
        return Some(name.to_lowercase());
    }
    let mut it = argv.iter();
    let mut first = it.next()?;
    if first == "env" {
        first = it.find(|a| !a.contains('='))?;
    }
    std::path::Path::new(first).file_name().map(|n| n.to_string_lossy().into_owned())
}

/// Turn one parsed entry into an app record, or None if it shouldn't be listed.
pub fn record(desktop_id: &str, path: &str, entry: &HashMap<String, String>, desktop: &str) -> Option<AppRecord> {
    if entry.get("Type").map(String::as_str) != Some("Application") {
        return None;
    }
    let yes = |k: &str| entry.get(k).is_some_and(|v| v.eq_ignore_ascii_case("true"));
    if yes("NoDisplay") || yes("Hidden") {
        return None;
    }
    let listed = |k: &str| entry.get(k).map(|v| v.split(';').any(|d| d.eq_ignore_ascii_case(desktop)));
    if listed("NotShowIn") == Some(true) || listed("OnlyShowIn") == Some(false) {
        return None;
    }
    let name = entry.get("Name")?.trim().to_string();
    if name.is_empty() || super::model::is_junk(&name) {
        return None;
    }
    let argv = exec_argv(entry.get("Exec")?);
    let exe_path = argv.first().cloned();
    let mut aliases: Vec<String> = Vec::new();
    for k in ["GenericName", "X-GNOME-FullName"] {
        if let Some(v) = entry.get(k).filter(|v| !v.is_empty() && !v.eq_ignore_ascii_case(&name)) {
            aliases.push(v.clone());
        }
    }
    if let Some(id) = entry.get("X-Flatpak") {
        aliases.push(id.clone());
    }
    let system = entry.get("Categories").is_some_and(|c| c.split(';').any(|x| x == "Settings" || x == "System"));
    Some(AppRecord {
        id: format!("desktop:{}", desktop_id.to_lowercase()),
        name,
        kind: if system { AppKind::System } else { AppKind::Win32 },
        app_id: Some(desktop_id.to_string()),
        family: entry.get("X-Flatpak").cloned(),
        exe_name: process_name(entry, &argv),
        exe_path,
        shortcut: Some(path.to_string()),
        uri: None,
        install_dir: None,
        aliases,
        source: if entry.contains_key("X-Flatpak") { "flatpak".into() } else { "desktop".into() },
    })
}

/// Directories holding `applications/`, highest priority first.
#[cfg(target_os = "linux")]
fn data_dirs() -> Vec<std::path::PathBuf> {
    let home = crate::linux::home();
    let mut dirs: Vec<std::path::PathBuf> = vec![std::env::var_os("XDG_DATA_HOME")
        .map(Into::into)
        .unwrap_or_else(|| home.join(".local/share"))];
    let sys = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    dirs.extend(sys.split(':').filter(|s| !s.is_empty()).map(Into::into));
    for extra in [
        home.join(".local/share/flatpak/exports/share"),
        "/var/lib/flatpak/exports/share".into(),
        "/var/lib/snapd/desktop".into(),
    ] {
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    dirs
}

#[cfg(target_os = "linux")]
pub fn scan() -> Vec<AppRecord> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .and_then(|d| d.split(':').next().map(str::to_string))
        .unwrap_or_else(|| "KDE".into());
    let mut seen = std::collections::HashSet::new();
    let mut apps = Vec::new();
    for base in data_dirs() {
        let root = base.join("applications");
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if p.extension().and_then(|x| x.to_str()) != Some("desktop") {
                    continue;
                }
                // Desktop-file id: path under applications/ with '/' → '-'.
                let id = p.strip_prefix(&root).unwrap_or(&p).to_string_lossy().replace('/', "-");
                // Higher-priority dirs come first; a user copy hides the system one.
                if !seen.insert(id.clone()) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&p) else { continue };
                if let Some(r) = record(&id, &p.to_string_lossy(), &parse_entry(&text), &desktop) {
                    apps.push(r);
                }
            }
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIREFOX: &str = "[Desktop Entry]\nName=Firefox\nGenericName=Web Browser\nExec=firefox %u\nType=Application\nCategories=Network;WebBrowser;\n\n[Desktop Action new-window]\nName=New Window\nExec=firefox --new-window %u\n";

    #[test]
    fn parses_main_group_only() {
        let e = parse_entry(FIREFOX);
        assert_eq!(e["Name"], "Firefox");
        assert_eq!(e["Exec"], "firefox %u");
    }

    #[test]
    fn exec_drops_field_codes_and_handles_quotes() {
        assert_eq!(exec_argv("firefox %u"), vec!["firefox"]);
        assert_eq!(exec_argv("\"/opt/My App/run\" --x %F"), vec!["/opt/My App/run", "--x"]);
        assert_eq!(exec_argv("echo 100%%"), vec!["echo", "100%"]);
    }

    #[test]
    fn record_for_regular_app() {
        let r = record("firefox.desktop", "/usr/share/applications/firefox.desktop", &parse_entry(FIREFOX), "KDE").unwrap();
        assert_eq!(r.id, "desktop:firefox.desktop");
        assert_eq!(r.exe_name.as_deref(), Some("firefox"));
        assert!(r.aliases.contains(&"Web Browser".to_string()));
    }

    #[test]
    fn flatpak_process_name() {
        let e = parse_entry("[Desktop Entry]\nName=Spotify\nExec=/usr/bin/flatpak run --branch=stable --command=spotify com.spotify.Client\nType=Application\nX-Flatpak=com.spotify.Client\n");
        let r = record("com.spotify.Client.desktop", "x", &e, "KDE").unwrap();
        assert_eq!(r.exe_name.as_deref(), Some("spotify"));
        assert_eq!(r.source, "flatpak");
        assert!(r.aliases.contains(&"com.spotify.Client".to_string()));
    }

    #[test]
    fn hides_nodisplay_and_other_desktops() {
        let hidden = parse_entry("[Desktop Entry]\nName=X\nExec=x\nType=Application\nNoDisplay=true\n");
        assert!(record("x.desktop", "x", &hidden, "KDE").is_none());
        let gnome = parse_entry("[Desktop Entry]\nName=X\nExec=x\nType=Application\nOnlyShowIn=GNOME;\n");
        assert!(record("x.desktop", "x", &gnome, "KDE").is_none());
        let kde = parse_entry("[Desktop Entry]\nName=X\nExec=x\nType=Application\nOnlyShowIn=KDE;\n");
        assert!(record("x.desktop", "x", &kde, "KDE").is_some());
    }
}
