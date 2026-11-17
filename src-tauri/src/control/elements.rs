//! Turning a window's raw UI Automation tree into a short list the AI can act
//! on. Pure, so the filtering is tested on any OS.

use serde::Serialize;

pub const PAT_INVOKE: u8 = 1;
pub const PAT_VALUE: u8 = 2;
pub const PAT_TOGGLE: u8 = 4;
pub const PAT_SELECT: u8 = 8;
pub const PAT_EXPAND: u8 = 16;

/// What UI Automation reports for one element (cached in one cross-process call).
#[derive(Debug, Clone, Default)]
pub struct RawElement {
    pub name: String,
    pub control_type: i32,
    pub automation_id: String,
    pub rect: (i32, i32, i32, i32), // left, top, right, bottom
    pub enabled: bool,
    pub offscreen: bool,
    pub password: bool,
    pub focusable: bool,
    pub value: Option<String>,
    pub read_only: bool,
    pub patterns: u8,
    /// 0 off, 1 on, 2 indeterminate.
    pub toggle_state: Option<i32>,
    /// 0 collapsed, 1 expanded, 2 partial, 3 leaf.
    pub expand_state: Option<i32>,
    pub selected: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UiElement {
    pub id: usize,
    pub role: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub actions: Vec<&'static str>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<&'static str>,
    pub password: bool,
    /// x, y, width, height in desktop pixels.
    pub rect: [i32; 4],
}

pub fn role(ct: i32) -> &'static str {
    match ct {
        50000 => "button",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "textbox",
        50005 => "link",
        50006 => "image",
        50007 => "list item",
        50008 => "list",
        50009 => "menu",
        50010 => "menu bar",
        50011 => "menu item",
        50012 => "progress bar",
        50013 => "radio button",
        50015 => "slider",
        50016 => "spinner",
        50017 => "status bar",
        50018 => "tabs",
        50019 => "tab",
        50020 => "text",
        50021 => "toolbar",
        50023 => "tree",
        50024 => "tree item",
        50026 => "group",
        50028 => "grid",
        50029 => "row",
        50030 => "document",
        50031 => "split button",
        50032 => "window",
        50033 => "pane",
        50035 => "column header",
        50037 => "title bar",
        _ => "control",
    }
}

const INTERACTIVE: &[i32] = &[50000, 50002, 50003, 50004, 50005, 50007, 50011, 50013, 50015, 50016, 50019, 50024, 50029, 50031, 50035];
const MAX_INTERACTIVE: usize = 250;
const MAX_TEXT: usize = 120;
const MAX_LABEL: usize = 120;

fn clip(s: &str, n: usize) -> String {
    let t: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= n {
        t
    } else {
        format!("{}…", t.chars().take(n).collect::<String>())
    }
}

fn actions(e: &RawElement) -> Vec<&'static str> {
    let mut a = Vec::new();
    if e.patterns & PAT_INVOKE != 0 {
        a.push("click");
    }
    if e.patterns & PAT_TOGGLE != 0 {
        a.push("toggle");
    }
    if e.patterns & PAT_SELECT != 0 {
        a.push("select");
    }
    if e.patterns & PAT_EXPAND != 0 && e.expand_state != Some(3) {
        a.push(if e.expand_state == Some(1) { "collapse" } else { "expand" });
    }
    if e.patterns & PAT_VALUE != 0 && !e.read_only && !e.password {
        a.push("type");
    }
    if a.is_empty() && INTERACTIVE.contains(&e.control_type) {
        a.push("click");
    }
    a
}

fn state(e: &RawElement) -> Option<&'static str> {
    if let Some(t) = e.toggle_state {
        return Some(match t {
            1 => "on",
            2 => "mixed",
            _ => "off",
        });
    }
    if e.selected == Some(true) {
        return Some("selected");
    }
    match e.expand_state {
        Some(0) => Some("collapsed"),
        Some(1) => Some("expanded"),
        _ => None,
    }
}

/// Which raw elements to show, as indexes into `raw`, plus the shaped list
/// (ids are positions in the returned list). Interactive controls come first in
/// screen order; readable text fills the rest.
pub fn shape(raw: &[RawElement]) -> (Vec<usize>, Vec<UiElement>, bool) {
    let mut interactive = Vec::new();
    let mut text = Vec::new();
    for (i, e) in raw.iter().enumerate() {
        let (l, t, r, b) = e.rect;
        if e.offscreen || r - l < 2 || b - t < 2 {
            continue;
        }
        let has_label = !e.name.trim().is_empty() || e.value.as_deref().is_some_and(|v| !v.trim().is_empty());
        let acts = actions(e);
        let is_interactive = !acts.is_empty() && (INTERACTIVE.contains(&e.control_type) || e.patterns != 0);
        if is_interactive && (has_label || e.control_type == 50004 || e.control_type == 50003) {
            interactive.push(i);
        } else if e.control_type == 50020 && has_label {
            text.push(i);
        }
    }
    let truncated = interactive.len() > MAX_INTERACTIVE || text.len() > MAX_TEXT;
    interactive.truncate(MAX_INTERACTIVE);
    text.truncate(MAX_TEXT);
    let mut picked: Vec<usize> = interactive.into_iter().chain(text).collect();
    // Reading order: top to bottom, then left to right (rows within ~8px).
    picked.sort_by_key(|&i| {
        let (l, t, _, _) = raw[i].rect;
        (t / 8, l)
    });
    let shaped = picked
        .iter()
        .enumerate()
        .map(|(id, &i)| {
            let e = &raw[i];
            let (l, t, r, b) = e.rect;
            UiElement {
                id,
                role: role(e.control_type),
                name: clip(&e.name, MAX_LABEL),
                // Never read back what's in a password box.
                value: if e.password { None } else { e.value.as_deref().filter(|v| !v.is_empty()).map(|v| clip(v, MAX_LABEL)) },
                actions: actions(e),
                enabled: e.enabled,
                state: state(e),
                password: e.password,
                rect: [l, t, r - l, b - t],
            }
        })
        .collect();
    (picked, shaped, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(name: &str, ct: i32, patterns: u8, rect: (i32, i32, i32, i32)) -> RawElement {
        RawElement { name: name.into(), control_type: ct, patterns, rect, enabled: true, ..Default::default() }
    }

    #[test]
    fn keeps_controls_drops_noise() {
        let raw = vec![
            el("Save", 50000, PAT_INVOKE, (100, 10, 160, 40)),
            el("", 50033, 0, (0, 0, 800, 600)),                     // nameless pane
            el("Hidden", 50000, PAT_INVOKE, (0, 0, 0, 0)),          // zero size
            el("Status: ready", 50020, 0, (0, 580, 200, 600)),      // readable text
            el("", 50004, PAT_VALUE, (10, 50, 400, 80)),            // unlabeled textbox still kept
            RawElement { offscreen: true, ..el("Off", 50000, PAT_INVOKE, (0, 0, 10, 10)) },
        ];
        let (idx, shaped, truncated) = shape(&raw);
        assert!(!truncated);
        let names: Vec<_> = shaped.iter().map(|e| (e.role, e.name.as_str())).collect();
        assert_eq!(names, vec![("button", "Save"), ("textbox", ""), ("text", "Status: ready")]);
        assert_eq!(idx, vec![0, 4, 3]);
        assert_eq!(shaped[1].actions, vec!["type"]);
        assert_eq!(shaped[0].rect, [100, 10, 60, 30]);
    }

    #[test]
    fn states_and_actions() {
        let mut cb = el("Dark mode", 50002, PAT_TOGGLE, (0, 0, 20, 20));
        cb.toggle_state = Some(1);
        let mut tree = el("Folder", 50024, PAT_EXPAND | PAT_SELECT, (0, 30, 20, 50));
        tree.expand_state = Some(0);
        let (_, s, _) = shape(&[cb, tree]);
        assert_eq!(s[0].state, Some("on"));
        assert_eq!(s[0].actions, vec!["toggle"]);
        assert_eq!(s[1].actions, vec!["select", "expand"]);
        assert_eq!(s[1].state, Some("collapsed"));
    }

    #[test]
    fn password_values_never_leave() {
        let mut pw = el("Password", 50004, PAT_VALUE, (0, 0, 100, 20));
        pw.password = true;
        pw.value = Some("hunter2".into());
        let (_, s, _) = shape(&[pw]);
        assert_eq!(s[0].value, None);
        assert!(s[0].password);
        assert!(!s[0].actions.contains(&"type"));
    }

    #[test]
    fn caps_and_reports_truncation() {
        let raw: Vec<_> = (0..300).map(|i| el(&format!("b{i}"), 50000, PAT_INVOKE, (0, i * 10, 50, i * 10 + 9))).collect();
        let (_, s, truncated) = shape(&raw);
        assert!(truncated);
        assert_eq!(s.len(), MAX_INTERACTIVE);
    }

    #[test]
    fn long_labels_are_clipped() {
        let long = "word ".repeat(100);
        let (_, s, _) = shape(&[el(&long, 50000, PAT_INVOKE, (0, 0, 10, 10))]);
        assert!(s[0].name.ends_with('…'));
        assert!(s[0].name.chars().count() <= MAX_LABEL + 1);
    }
}
