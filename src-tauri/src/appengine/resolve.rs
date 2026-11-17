//! Natural-language app name → installed app. Pure and deterministic: the AI
//! passes what the user said; this decides what that means, so the AI never
//! invents paths or commands.

use super::model::{AppKind, AppRecord};
use serde::Serialize;

/// Common ways people refer to apps, mapped to words in the real name.
const ALIASES: &[(&str, &str)] = &[
    ("vs code", "visual studio code"),
    ("vscode", "visual studio code"),
    ("code", "visual studio code"),
    ("calc", "calculator"),
    ("edge", "microsoft edge"),
    ("chrome", "google chrome"),
    ("teams", "microsoft teams"),
    ("store", "microsoft store"),
    ("ms store", "microsoft store"),
    ("app store", "microsoft store"),
    ("terminal", "terminal"),
    ("obs", "obs studio"),
    ("snipping tool", "snipping tool"),
    ("snip", "snipping tool"),
    ("paint", "paint"),
    ("outlook", "outlook"),
    ("photos", "photos"),
    ("xbox", "xbox"),
    ("whatsapp", "whatsapp"),
    ("ea app", "ea"),
    ("epic", "epic games launcher"),
    ("epic games", "epic games launcher"),
    ("battle net", "battle.net"),
    ("battlenet", "battle.net"),
    ("gpu software", "amd software"),
    ("radeon software", "amd software"),
    ("adrenalin", "amd software"),
    ("geforce", "geforce experience"),
    ("anti micro", "antimicro"),
    ("9n1fcfq6p5lw", "antimicro"),
];

/// Store product IDs for apps the user has asked about, so "not installed"
/// can point at the official listing (and the ID itself resolves by name).
pub const KNOWN_STORE_APPS: &[(&str, &str)] = &[("antimicro", "9N1FCFQ6P5LW")];

/// Official Microsoft Store page for a not-installed app, if we know it.
pub fn store_link(query: &str) -> Option<String> {
    let q = compact(&normalise(query));
    KNOWN_STORE_APPS
        .iter()
        .find(|(name, id)| q == compact(name) || q == id.to_lowercase())
        .map(|(_, id)| format!("https://apps.microsoft.com/detail/{id}"))
}

/// Vendor names dropped to make "Google Chrome" also match "chrome".
const VENDORS: &[&str] = &[
    "microsoft", "google", "adobe", "mozilla", "apple", "nvidia", "amd", "valve", "jetbrains", "autodesk",
    "logitech", "razer", "corsair", "steelseries", "spotify", "discord", "the",
];

pub fn normalise(s: &str) -> String {
    let mut t = s.to_lowercase().replace('&', " and ").replace(['™', '®', '©'], "");
    t = t.chars().map(|c| if c.is_alphanumeric() || c == '.' { c } else { ' ' }).collect();
    let mut words: Vec<&str> = t.split_whitespace().collect();
    while matches!(words.first(), Some(&"the") | Some(&"my")) && words.len() > 1 {
        words.remove(0);
    }
    while matches!(words.last(), Some(&"app") | Some(&"application") | Some(&"program") | Some(&"programme")) && words.len() > 1 {
        words.pop();
    }
    words.join(" ")
}

fn compact(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

fn is_versionish(w: &str) -> bool {
    w.chars().any(|c| c.is_ascii_digit()) && w.chars().all(|c| c.is_ascii_digit() || c == '.' || c == 'x' || c == 'v')
        || matches!(w, "x64" | "x86" | "64bit" | "32bit" | "beta" | "preview" | "insiders")
}

/// Forms a record can be called by.
pub fn variants(a: &AppRecord) -> Vec<String> {
    let mut v = Vec::new();
    let full = normalise(&a.name);
    // Without "(…)" parts and version numbers: "Adobe Photoshop 2025" → "adobe photoshop".
    let no_paren: String = {
        let mut depth = 0;
        a.name.chars().filter(|c| {
            match c {
                '(' => depth += 1,
                ')' => { depth -= 1; return false; }
                _ => {}
            }
            depth == 0
        }).collect()
    };
    let core: String = normalise(&no_paren).split(' ').filter(|w| !is_versionish(w)).collect::<Vec<_>>().join(" ");
    let words: Vec<&str> = core.split(' ').collect();
    let no_vendor = if words.len() > 1 && VENDORS.contains(&words[0]) { Some(words[1..].join(" ")) } else { None };
    v.push(full);
    if !core.is_empty() {
        v.push(core.clone());
    }
    if let Some(n) = no_vendor {
        v.push(n);
    }
    if let Some(exe) = &a.exe_name {
        let stem = exe.to_lowercase().trim_end_matches(".exe").trim_end_matches("64").trim_end_matches("32").to_string();
        if stem.len() >= 3 {
            v.push(stem);
        }
    }
    v.extend(a.aliases.iter().map(|s| normalise(s)));
    v.sort();
    v.dedup();
    v.retain(|s| !s.is_empty());
    v
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// How well `q` (normalised) names variant `v`, 0–100.
fn score_variant(q: &str, v: &str) -> u32 {
    let (qc, vc) = (compact(q), compact(v));
    if qc.is_empty() || vc.is_empty() {
        return 0;
    }
    if q == v || qc == vc {
        return 100;
    }
    let mut best = 0;
    // Word prefix: "visual studio" → "visual studio code"; "antimicro" → "antimicrox".
    if v.starts_with(&format!("{q} ")) || (qc.len() >= 4 && vc.starts_with(&qc)) {
        best = best.max(88 - ((vc.len() - qc.len()) as u32 / 2).min(10));
    }
    let qt: Vec<&str> = q.split(' ').collect();
    let vt: Vec<&str> = v.split(' ').collect();
    if qt.iter().all(|t| t.len() >= 2 && vt.contains(t)) {
        best = best.max(82u32.saturating_sub((vt.len() - qt.len()) as u32 * 2));
    }
    if vt.len() >= 2 && qc.len() >= 2 {
        let initials: String = vt.iter().filter_map(|w| w.chars().next()).collect();
        if initials == qc {
            best = best.max(78);
        }
    }
    if qc.len() >= 4 && vc.contains(&qc) {
        best = best.max(72);
    }
    if qc.len() >= 4 {
        let d = levenshtein(&qc, &vc);
        let sim = 1.0 - d as f64 / qc.len().max(vc.len()) as f64;
        if sim >= 0.75 {
            best = best.max((50.0 + 40.0 * sim) as u32);
        }
    }
    best
}

pub fn score(query: &str, a: &AppRecord) -> u32 {
    let q = normalise(query);
    if q.is_empty() {
        return 0;
    }
    let mut queries = vec![q.clone()];
    for (alias, target) in ALIASES {
        if q == *alias {
            queries.push(target.to_string());
        }
    }
    let mut best = 0;
    for v in variants(a) {
        for qq in &queries {
            best = best.max(score_variant(qq, &v));
        }
    }
    // Small tie-breaker: Start-menu apps over loose exes.
    if best > 0 && a.source == "apppaths" {
        best = best.saturating_sub(3);
    }
    best
}

#[derive(Serialize, Clone, Debug)]
pub struct Candidate {
    pub app: AppRecord,
    pub score: u32,
}

/// Best matches, one per real app (same exe / AUMID collapsed).
pub fn search(query: &str, apps: &[AppRecord], limit: usize) -> Vec<Candidate> {
    let mut c: Vec<Candidate> = apps
        .iter()
        .map(|a| Candidate { app: a.clone(), score: score(query, a) })
        .filter(|c| c.score >= 45)
        .collect();
    c.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| kind_rank(&a.app.kind).cmp(&kind_rank(&b.app.kind))).then_with(|| a.app.name.len().cmp(&b.app.name.len())));
    let mut out: Vec<Candidate> = Vec::new();
    for cand in c {
        let dup = out.iter().any(|o| same_app(&o.app, &cand.app));
        if !dup {
            out.push(cand);
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn kind_rank(k: &AppKind) -> u8 {
    match k {
        AppKind::Packaged | AppKind::Win32 => 0,
        AppKind::System => 1,
    }
}

fn same_app(a: &AppRecord, b: &AppRecord) -> bool {
    let eq = |x: &Option<String>, y: &Option<String>| matches!((x, y), (Some(x), Some(y)) if x.eq_ignore_ascii_case(y));
    eq(&a.app_id, &b.app_id) || eq(&a.exe_path, &b.exe_path) || (a.kind != AppKind::System && b.kind != AppKind::System && eq(&a.exe_name, &b.exe_name))
}

#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Resolution {
    Found { app: AppRecord, score: u32 },
    Ambiguous { options: Vec<Candidate> },
    NotFound { suggestions: Vec<Candidate> },
}

pub fn resolve(query: &str, apps: &[AppRecord]) -> Resolution {
    let c = search(query, apps, 6);
    let Some(top) = c.first() else { return Resolution::NotFound { suggestions: vec![] } };
    if top.score < 60 {
        return Resolution::NotFound { suggestions: c.into_iter().take(3).collect() };
    }
    let second = c.get(1).map(|x| x.score).unwrap_or(0);
    // Two apps that both match exactly: ask.
    if top.score == 100 && second == 100 {
        return Resolution::Ambiguous { options: c.into_iter().filter(|x| x.score == 100).collect() };
    }
    if top.score >= 80 && top.score >= second + 6 {
        let t = c.into_iter().next().unwrap();
        return Resolution::Found { app: t.app, score: t.score };
    }
    let floor = top.score.saturating_sub(12).max(60);
    let close: Vec<Candidate> = c.into_iter().filter(|x| x.score >= floor).collect();
    if close.len() == 1 && close[0].score >= 70 {
        let t = close.into_iter().next().unwrap();
        return Resolution::Found { app: t.app, score: t.score };
    }
    Resolution::Ambiguous { options: close }
}
