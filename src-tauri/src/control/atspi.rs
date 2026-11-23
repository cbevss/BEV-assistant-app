//! Reading and operating app controls on Linux through AT-SPI (the
//! accessibility bus screen readers like Orca use). The tree is mapped onto
//! the same RawElement model as Windows UI Automation, so `elements::shape`
//! and the AI-facing list are identical on both systems.

use super::elements::{RawElement, PAT_EXPAND, PAT_INVOKE, PAT_SELECT, PAT_TOGGLE, PAT_VALUE};

// AT-SPI roles (atspi-constants.h) that matter here.
pub const ROLE_CHECK_BOX: u32 = 7;
pub const ROLE_PASSWORD_TEXT: u32 = 40;

// AT-SPI state bits.
const CHECKED: u32 = 4;
const COLLAPSED: u32 = 5;
const EDITABLE: u32 = 7;
const ENABLED: u32 = 8;
const EXPANDABLE: u32 = 9;
const EXPANDED: u32 = 10;
const FOCUSABLE: u32 = 11;
pub const FOCUSED: u32 = 12;
const PRESSED: u32 = 20;
const SELECTABLE: u32 = 22;
const SELECTED: u32 = 23;
const SENSITIVE: u32 = 24;
pub const SHOWING: u32 = 25;
const INDETERMINATE: u32 = 32;
const CHECKABLE: u32 = 41;
const READ_ONLY: u32 = 43;

pub fn has(states: &[u32], bit: u32) -> bool {
    states.get((bit / 32) as usize).is_some_and(|w| w & (1 << (bit % 32)) != 0)
}

/// AT-SPI role → the UI Automation control type `elements` understands.
pub fn uia_type(role: u32) -> i32 {
    match role {
        43 | 62 => 50000,      // push / toggle button
        7 | 8 => 50002,        // check box / check menu item
        11 => 50003,           // combo box
        40 | 61 | 79 | 77 => 50004, // password / text / entry / editbar
        52 => 50016,           // spin button
        88 => 50005,           // link
        26 | 27 => 50006,      // icon / image
        32 | 56 => 50007,      // list item / table cell
        31 => 50008,           // list
        33 | 41 => 50009,      // menu / popup menu
        34 => 50010,           // menu bar
        35 | 45 | 59 => 50011, // menu items
        42 => 50012,           // progress bar
        44 => 50013,           // radio button
        51 => 50015,           // slider
        54 => 50017,           // status bar
        38 => 50018,           // page tab list
        37 => 50019,           // page tab
        29 | 73 | 83 | 81 | 64 => 50020, // label / paragraph / heading / caption / tooltip
        63 => 50021,           // tool bar
        65 | 66 => 50023,      // tree / tree table
        82 => 50030,           // document frame
        16 | 23 | 69 => 50032, // dialog / frame / window
        39 | 85 | 20 => 50026, // panel / section / filler
        _ => 50025,
    }
}

pub struct Node<'a> {
    pub role: u32,
    pub name: &'a str,
    pub states: &'a [u32],
    pub has_action: bool,
    pub editable_text: bool,
    pub value: Option<String>,
    /// left, top, right, bottom in desktop pixels.
    pub rect: (i32, i32, i32, i32),
}

pub fn raw(n: &Node) -> RawElement {
    let ct = uia_type(n.role);
    let s = n.states;
    let password = n.role == ROLE_PASSWORD_TEXT;
    let checkable = has(s, CHECKABLE) || matches!(n.role, 7 | 8 | 44 | 45 | 62);
    let mut patterns = 0;
    if n.has_action && !matches!(ct, 50004 | 50020) {
        patterns |= PAT_INVOKE;
    }
    if checkable {
        patterns |= PAT_TOGGLE;
    }
    if has(s, SELECTABLE) && matches!(ct, 50007 | 50019 | 50024) {
        patterns |= PAT_SELECT;
    }
    if has(s, EXPANDABLE) {
        patterns |= PAT_EXPAND;
    }
    let editable = n.editable_text && has(s, EDITABLE);
    if editable || (ct == 50004 && !has(s, READ_ONLY)) {
        patterns |= PAT_VALUE;
    }
    RawElement {
        name: n.name.to_string(),
        control_type: ct,
        automation_id: String::new(),
        rect: n.rect,
        enabled: has(s, ENABLED) || has(s, SENSITIVE),
        offscreen: !has(s, SHOWING),
        password,
        focusable: has(s, FOCUSABLE),
        value: if password { None } else { n.value.clone() },
        read_only: has(s, READ_ONLY) || (ct == 50004 && !editable && n.editable_text),
        patterns,
        toggle_state: checkable.then(|| if has(s, INDETERMINATE) { 2 } else if has(s, CHECKED) || has(s, PRESSED) { 1 } else { 0 }),
        expand_state: has(s, EXPANDABLE).then(|| if has(s, EXPANDED) { 1 } else if has(s, COLLAPSED) { 0 } else { 0 }),
        selected: has(s, SELECTABLE).then(|| has(s, SELECTED)),
    }
}

/// Pick the action to run for a BEV verb from an element's AT-SPI action names.
pub fn pick_action(names: &[String], verb: &str) -> Option<usize> {
    let wanted: &[&str] = match verb {
        "click" => &["click", "press", "activate", "jump", "open", "invoke"],
        "toggle" => &["toggle", "click", "press", "activate"],
        "select" => &["select", "click", "activate", "press"],
        "expand" | "collapse" => &["expand or contract", "expand or collapse", "toggle", "open", "expand", "collapse", "click", "activate"],
        _ => &[],
    };
    for w in wanted {
        if let Some(i) = names.iter().position(|n| n.eq_ignore_ascii_case(w)) {
            return Some(i);
        }
    }
    (!names.is_empty() && verb == "click").then_some(0)
}

#[cfg(target_os = "linux")]
pub mod bus {
    //! The live AT-SPI client (Linux only).
    use super::*;
    use zbus::zvariant::{OwnedObjectPath, OwnedValue};

    pub type Ref = (String, OwnedObjectPath);

    static A11Y: tokio::sync::OnceCell<zbus::Connection> = tokio::sync::OnceCell::const_new();

    const ACC: &str = "org.a11y.atspi.Accessible";
    const MAX_NODES: usize = 2500;

    /// Connect to the accessibility bus, switching accessibility on so Qt,
    /// GTK and Chromium apps start publishing their controls.
    pub async fn conn() -> Result<&'static zbus::Connection, String> {
        A11Y.get_or_try_init(|| async {
            let session = zbus::Connection::session().await.map_err(|e| e.to_string())?;
            let _ = session
                .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.freedesktop.DBus.Properties"), "Set", &("org.a11y.Status", "IsEnabled", zbus::zvariant::Value::from(true)))
                .await;
            let addr: String = session
                .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
                .await
                .map_err(|e| format!("the accessibility bus isn't running ({e})"))?
                .body()
                .deserialize()
                .map_err(|e| e.to_string())?;
            zbus::connection::Builder::address(addr.as_str()).map_err(|e| e.to_string())?.build().await.map_err(|e| format!("accessibility bus: {e}"))
        })
        .await
    }

    async fn call<B>(c: &zbus::Connection, r: &Ref, iface: &str, method: &str, args: &(impl serde::Serialize + zbus::zvariant::DynamicType)) -> Result<B, String>
    where
        B: for<'d> zbus::zvariant::DynamicDeserialize<'d> + for<'d> serde::Deserialize<'d> + zbus::zvariant::Type,
    {
        c.call_method(Some(r.0.as_str()), r.1.as_str(), Some(iface), method, args)
            .await
            .map_err(|e| e.to_string())?
            .body()
            .deserialize::<B>()
            .map_err(|e| e.to_string())
    }

    async fn prop(c: &zbus::Connection, r: &Ref, iface: &str, name: &str) -> Option<OwnedValue> {
        call::<OwnedValue>(c, r, "org.freedesktop.DBus.Properties", "Get", &(iface, name)).await.ok()
    }

    async fn children(c: &zbus::Connection, r: &Ref) -> Vec<Ref> {
        call::<Vec<(String, OwnedObjectPath)>>(c, r, ACC, "GetChildren", &()).await.unwrap_or_default()
    }

    pub async fn name(c: &zbus::Connection, r: &Ref) -> String {
        prop(c, r, ACC, "Name").await.and_then(|v| String::try_from(v).ok()).unwrap_or_default()
    }

    pub async fn role(c: &zbus::Connection, r: &Ref) -> u32 {
        call::<u32>(c, r, ACC, "GetRole", &()).await.unwrap_or(0)
    }

    pub async fn states(c: &zbus::Connection, r: &Ref) -> Vec<u32> {
        call::<Vec<u32>>(c, r, ACC, "GetState", &()).await.unwrap_or_default()
    }

    async fn interfaces(c: &zbus::Connection, r: &Ref) -> Vec<String> {
        call::<Vec<String>>(c, r, ACC, "GetInterfaces", &()).await.unwrap_or_default()
    }

    /// The top-level AT-SPI window of a process whose title matches best.
    pub async fn window_for(pid: u32, title: &str) -> Result<Ref, String> {
        let c = conn().await?;
        let root: Ref = ("org.a11y.atspi.Registry".into(), OwnedObjectPath::try_from("/org/a11y/atspi/accessible/root").unwrap());
        let mut fallback = None;
        for app in children(c, &root).await {
            let app_pid: u32 = c
                .call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "GetConnectionUnixProcessID", &(app.0.as_str(),))
                .await
                .ok()
                .and_then(|m| m.body().deserialize().ok())
                .unwrap_or(0);
            if app_pid != pid {
                continue;
            }
            for w in children(c, &app).await {
                let n = name(c, &w).await;
                if !title.is_empty() && (n == title || title.contains(&n) && !n.is_empty()) {
                    return Ok(w);
                }
                if fallback.is_none() && has(&states(c, &w).await, SHOWING) {
                    fallback = Some(w);
                }
            }
        }
        fallback.ok_or_else(|| "That app doesn't share its controls (no accessibility support). BEV can still use the screen.".into())
    }

    pub struct Walked {
        pub refs: Vec<Ref>,
        pub raw: Vec<RawElement>,
    }

    /// Read every showing control under a window. `(ox, oy)` is the window's
    /// content origin on the desktop: Wayland apps report window-relative positions.
    pub async fn walk(win: &Ref, ox: i32, oy: i32) -> Result<Walked, String> {
        let c = conn().await?;
        let mut out = Walked { refs: Vec::new(), raw: Vec::new() };
        let mut stack = children(c, win).await;
        stack.reverse();
        let mut seen = 0usize;
        while let Some(r) = stack.pop() {
            seen += 1;
            if seen > MAX_NODES {
                break;
            }
            let st = states(c, &r).await;
            if !has(&st, SHOWING) {
                continue; // hidden containers hide their children too
            }
            let ifaces = interfaces(c, &r).await;
            let has_if = |i: &str| ifaces.iter().any(|x| x == i);
            let rl = role(c, &r).await;
            let nm = name(c, &r).await;
            let rect = if has_if("org.a11y.atspi.Component") {
                // coord type 1 = relative to the window.
                call::<(i32, i32, i32, i32)>(c, &r, "org.a11y.atspi.Component", "GetExtents", &(1u32,))
                    .await
                    .map(|(x, y, w, h)| (ox + x, oy + y, ox + x + w, oy + y + h))
                    .unwrap_or_default()
            } else {
                (0, 0, 0, 0)
            };
            let value = if has_if("org.a11y.atspi.Text") && matches!(uia_type(rl), 50004 | 50003 | 50016) && rl != ROLE_PASSWORD_TEXT {
                call::<String>(c, &r, "org.a11y.atspi.Text", "GetText", &(0i32, 500i32)).await.ok()
            } else if has_if("org.a11y.atspi.Value") {
                prop(c, &r, "org.a11y.atspi.Value", "CurrentValue").await.and_then(|v| f64::try_from(v).ok()).map(|v| format!("{v}"))
            } else {
                None
            };
            let node = Node { role: rl, name: &nm, states: &st, has_action: has_if("org.a11y.atspi.Action"), editable_text: has_if("org.a11y.atspi.EditableText"), value, rect };
            out.raw.push(raw(&node));
            out.refs.push(r.clone());
            let mut kids = children(c, &r).await;
            kids.reverse();
            stack.extend(kids);
        }
        Ok(out)
    }

    pub async fn action_names(r: &Ref) -> Vec<String> {
        let Ok(c) = conn().await else { return Vec::new() };
        call::<Vec<(String, String, String)>>(c, r, "org.a11y.atspi.Action", "GetActions", &()).await.map(|v| v.into_iter().map(|a| a.0).collect()).unwrap_or_default()
    }

    pub async fn do_action(r: &Ref, index: usize) -> Result<bool, String> {
        let c = conn().await?;
        call::<bool>(c, r, "org.a11y.atspi.Action", "DoAction", &(index as i32,)).await
    }

    pub async fn grab_focus(r: &Ref) -> Result<bool, String> {
        let c = conn().await?;
        call::<bool>(c, r, "org.a11y.atspi.Component", "GrabFocus", &()).await
    }

    pub async fn set_text(r: &Ref, text: &str) -> Result<bool, String> {
        let c = conn().await?;
        call::<bool>(c, r, "org.a11y.atspi.EditableText", "SetTextContents", &(text,)).await
    }

    pub async fn get_text(r: &Ref) -> Option<String> {
        let c = conn().await.ok()?;
        call::<String>(c, r, "org.a11y.atspi.Text", "GetText", &(0i32, -1i32)).await.ok()
    }

    pub async fn state_of(r: &Ref) -> Vec<u32> {
        match conn().await {
            Ok(c) => states(c, r).await,
            Err(_) => Vec::new(),
        }
    }

    /// Is the focused control in this window a password box? Stops at the
    /// first focused element.
    pub async fn focused_is_password(win: &Ref) -> bool {
        let Ok(c) = conn().await else { return false };
        let mut stack = children(c, win).await;
        let mut seen = 0;
        while let Some(r) = stack.pop() {
            seen += 1;
            if seen > 1500 {
                return false;
            }
            let st = states(c, &r).await;
            if !has(&st, SHOWING) {
                continue;
            }
            if has(&st, FOCUSED) {
                return role(c, &r).await == ROLE_PASSWORD_TEXT;
            }
            stack.extend(children(c, &r).await);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(bits: &[u32]) -> Vec<u32> {
        let mut v = vec![0u32, 0u32];
        for &b in bits {
            v[(b / 32) as usize] |= 1 << (b % 32);
        }
        v
    }

    #[test]
    fn maps_a_button() {
        let s = st(&[ENABLED, SHOWING, FOCUSABLE]);
        let r = raw(&Node { role: 43, name: "Save", states: &s, has_action: true, editable_text: false, value: None, rect: (10, 10, 90, 40) });
        assert_eq!(r.control_type, 50000);
        assert!(r.patterns & PAT_INVOKE != 0);
        assert!(r.enabled && !r.offscreen);
    }

    #[test]
    fn maps_checkbox_state_and_password() {
        let s = st(&[ENABLED, SHOWING, CHECKABLE, CHECKED]);
        let r = raw(&Node { role: ROLE_CHECK_BOX, name: "Remember me", states: &s, has_action: true, editable_text: false, value: None, rect: (0, 0, 20, 20) });
        assert_eq!(r.toggle_state, Some(1));
        let s = st(&[ENABLED, SHOWING, EDITABLE]);
        let p = raw(&Node { role: ROLE_PASSWORD_TEXT, name: "Password", states: &s, has_action: false, editable_text: true, value: Some("secret".into()), rect: (0, 0, 100, 20) });
        assert!(p.password && p.value.is_none());
        assert_eq!(p.control_type, 50004);
    }

    #[test]
    fn hidden_is_offscreen_and_high_bits_work() {
        let s = st(&[ENABLED, READ_ONLY]);
        let r = raw(&Node { role: 79, name: "", states: &s, has_action: false, editable_text: true, value: Some("x".into()), rect: (0, 0, 50, 20) });
        assert!(r.offscreen && r.read_only);
    }

    #[test]
    fn picks_actions() {
        let names = vec!["Press".to_string(), "SetFocus".to_string()];
        assert_eq!(pick_action(&names, "click"), Some(0));
        assert_eq!(pick_action(&["toggle".into()], "toggle"), Some(0));
        assert_eq!(pick_action(&["expand or contract".into()], "expand"), Some(0));
        assert_eq!(pick_action(&[], "click"), None);
    }
}
