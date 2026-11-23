//! UI Automation: read a window's controls and operate them the way a screen
//! reader does (Invoke, Toggle, SetValue…), falling back to a real click only
//! when a control offers nothing else.
//!
//! COM objects can't cross threads, so one worker thread owns the UI
//! Automation client and the elements from the last read; commands talk to it
//! over a channel.

use super::elements::UiElement;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct UiSnapshot {
    pub title: String,
    pub process: String,
    pub hwnd: isize,
    pub elements: Vec<UiElement>,
    /// More controls exist than were listed.
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct ActResult {
    /// What BEV did, in plain words.
    pub done: String,
    /// Whether the effect was confirmed by reading the control back.
    pub verified: bool,
    pub detail: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct PointInfo {
    pub name: String,
    pub role: &'static str,
    pub process: String,
    pub password: bool,
}

#[cfg(windows)]
mod imp {
    use super::super::elements::{self, RawElement, PAT_EXPAND, PAT_INVOKE, PAT_SELECT, PAT_TOGGLE, PAT_VALUE};
    use super::super::{guard, input, win};
    use super::*;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use windows::core::{BSTR, VARIANT};
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::*;

    type Reply<T> = Sender<Result<T, String>>;
    enum Req {
        Read { hwnd: Option<isize>, reply: Reply<UiSnapshot> },
        Act { id: usize, action: String, text: Option<String>, reply: Reply<ActResult> },
        At { x: i32, y: i32, reply: Reply<Option<PointInfo>> },
        FocusedIsPassword { reply: Reply<bool> },
    }

    static WORKER: OnceLock<Mutex<Sender<Req>>> = OnceLock::new();

    fn call<T>(make: impl FnOnce(Reply<T>) -> Req) -> Result<T, String> {
        let tx = WORKER
            .get_or_init(|| {
                let (tx, rx) = channel::<Req>();
                std::thread::Builder::new()
                    .name("bev-uia".into())
                    .spawn(move || Worker::new().run(rx))
                    .expect("spawn UI Automation worker");
                Mutex::new(tx)
            })
            .lock()
            .map_err(|_| "UI Automation worker unavailable".to_string())?
            .clone();
        let (rtx, rrx) = channel();
        tx.send(make(rtx)).map_err(|_| "UI Automation worker stopped".to_string())?;
        rrx.recv_timeout(Duration::from_secs(20)).map_err(|_| "reading the window took too long".to_string())?
    }

    pub fn read(hwnd: Option<isize>) -> Result<UiSnapshot, String> {
        call(|reply| Req::Read { hwnd, reply })
    }
    pub fn act(id: usize, action: String, text: Option<String>) -> Result<ActResult, String> {
        call(|reply| Req::Act { id, action, text, reply })
    }
    pub fn element_at(x: i32, y: i32) -> Result<Option<PointInfo>, String> {
        call(|reply| Req::At { x, y, reply })
    }
    pub fn focused_is_password() -> Result<bool, String> {
        call(|reply| Req::FocusedIsPassword { reply })
    }

    struct Worker {
        uia: Result<IUIAutomation, String>,
        last: Vec<IUIAutomationElement>,
        last_hwnd: isize,
    }

    const PROPS: &[UIA_PROPERTY_ID] = &[
        UIA_NamePropertyId,
        UIA_ControlTypePropertyId,
        UIA_AutomationIdPropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_IsPasswordPropertyId,
        UIA_IsKeyboardFocusablePropertyId,
        UIA_IsInvokePatternAvailablePropertyId,
        UIA_IsValuePatternAvailablePropertyId,
        UIA_IsTogglePatternAvailablePropertyId,
        UIA_IsSelectionItemPatternAvailablePropertyId,
        UIA_IsExpandCollapsePatternAvailablePropertyId,
        UIA_ValueValuePropertyId,
        UIA_ValueIsReadOnlyPropertyId,
        UIA_ToggleToggleStatePropertyId,
        UIA_ExpandCollapseExpandCollapseStatePropertyId,
        UIA_SelectionItemIsSelectedPropertyId,
    ];

    fn b(v: &VARIANT) -> bool {
        bool::try_from(v).unwrap_or(false)
    }
    fn gone(e: windows::core::Error) -> String {
        // UIA_E_ELEMENTNOTAVAILABLE
        if e.code().0 as u32 == 0x8004_0201 {
            "That control is gone (the window changed). Read the window again.".into()
        } else {
            e.message().to_string()
        }
    }

    impl Worker {
        fn new() -> Self {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let uia = CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("UI Automation isn't available: {e}"));
                Worker { uia, last: Vec::new(), last_hwnd: 0 }
            }
        }

        fn run(mut self, rx: std::sync::mpsc::Receiver<Req>) {
            for req in rx {
                match req {
                    Req::Read { hwnd, reply } => {
                        let _ = reply.send(self.read(hwnd));
                    }
                    Req::Act { id, action, text, reply } => {
                        let _ = reply.send(self.act(id, &action, text.as_deref()));
                    }
                    Req::At { x, y, reply } => {
                        let _ = reply.send(self.at(x, y));
                    }
                    Req::FocusedIsPassword { reply } => {
                        let r = self.uia.clone().and_then(|u| unsafe {
                            match u.GetFocusedElement() {
                                Ok(e) => Ok(e.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false)),
                                Err(_) => Ok(false),
                            }
                        });
                        let _ = reply.send(r);
                    }
                }
            }
        }

        fn read(&mut self, hwnd: Option<isize>) -> Result<UiSnapshot, String> {
            let uia = self.uia.clone()?;
            let target = match hwnd {
                Some(h) => win::info(HWND(h as *mut _)),
                None => win::user_window().ok_or("There's no window to read.")?,
            };
            unsafe {
                let root = uia.ElementFromHandle(HWND(target.hwnd as *mut _)).map_err(|e| format!("couldn't read that window: {e}"))?;
                let cr = uia.CreateCacheRequest().map_err(|e| e.to_string())?;
                for &p in PROPS {
                    cr.AddProperty(p).map_err(|e| e.to_string())?;
                }
                let cond = uia.ControlViewCondition().map_err(|e| e.to_string())?;
                let found = root.FindAllBuildCache(TreeScope_Descendants, &cond, &cr).map_err(|e| format!("couldn't read that window: {e}"))?;
                let n = found.Length().unwrap_or(0).min(4000);
                let mut raw = Vec::with_capacity(n as usize);
                let mut els = Vec::with_capacity(n as usize);
                for i in 0..n {
                    let Ok(e) = found.GetElement(i) else { continue };
                    let get = |p| e.GetCachedPropertyValue(p).unwrap_or_default();
                    let r = e.CachedBoundingRectangle().unwrap_or_default();
                    let mut patterns = 0u8;
                    for (prop, bit) in [
                        (UIA_IsInvokePatternAvailablePropertyId, PAT_INVOKE),
                        (UIA_IsValuePatternAvailablePropertyId, PAT_VALUE),
                        (UIA_IsTogglePatternAvailablePropertyId, PAT_TOGGLE),
                        (UIA_IsSelectionItemPatternAvailablePropertyId, PAT_SELECT),
                        (UIA_IsExpandCollapsePatternAvailablePropertyId, PAT_EXPAND),
                    ] {
                        if b(&get(prop)) {
                            patterns |= bit;
                        }
                    }
                    let value = if patterns & PAT_VALUE != 0 { BSTR::try_from(&get(UIA_ValueValuePropertyId)).ok().map(|s| s.to_string()) } else { None };
                    raw.push(RawElement {
                        name: e.CachedName().map(|s| s.to_string()).unwrap_or_default(),
                        control_type: e.CachedControlType().map(|c| c.0).unwrap_or(0),
                        automation_id: e.CachedAutomationId().map(|s| s.to_string()).unwrap_or_default(),
                        rect: (r.left, r.top, r.right, r.bottom),
                        enabled: e.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true),
                        offscreen: e.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false),
                        password: e.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false),
                        focusable: e.CachedIsKeyboardFocusable().map(|b| b.as_bool()).unwrap_or(false),
                        value,
                        read_only: b(&get(UIA_ValueIsReadOnlyPropertyId)),
                        patterns,
                        toggle_state: if patterns & PAT_TOGGLE != 0 { i32::try_from(&get(UIA_ToggleToggleStatePropertyId)).ok() } else { None },
                        expand_state: if patterns & PAT_EXPAND != 0 { i32::try_from(&get(UIA_ExpandCollapseExpandCollapseStatePropertyId)).ok() } else { None },
                        selected: if patterns & PAT_SELECT != 0 { Some(b(&get(UIA_SelectionItemIsSelectedPropertyId))) } else { None },
                    });
                    els.push(e);
                }
                let (picked, shaped, truncated) = elements::shape(&raw);
                self.last = picked.iter().map(|&i| els[i].clone()).collect();
                self.last_hwnd = target.hwnd;
                Ok(UiSnapshot { title: target.title, process: target.process, hwnd: target.hwnd, elements: shaped, truncated })
            }
        }

        fn at(&mut self, x: i32, y: i32) -> Result<Option<PointInfo>, String> {
            let uia = self.uia.clone()?;
            unsafe {
                let Ok(e) = uia.ElementFromPoint(POINT { x, y }) else { return Ok(None) };
                let pid = e.CurrentProcessId().unwrap_or(0) as u32;
                Ok(Some(PointInfo {
                    name: e.CurrentName().map(|s| s.to_string()).unwrap_or_default(),
                    role: elements::role(e.CurrentControlType().map(|c| c.0).unwrap_or(0)),
                    process: win::process_name(pid),
                    password: e.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false),
                }))
            }
        }

        fn act(&mut self, id: usize, action: &str, text: Option<&str>) -> Result<ActResult, String> {
            let e = self.last.get(id).cloned().ok_or_else(|| format!("There's no control #{id}. Read the window again."))?;
            unsafe {
                let name = e.CurrentName().map_err(gone)?.to_string();
                let label = if name.trim().is_empty() { format!("control #{id}") } else { format!("\"{}\"", name.trim()) };
                let pid = e.CurrentProcessId().unwrap_or(0) as u32;
                let process = win::process_name(pid);
                let owner = win::info(HWND(self.last_hwnd as *mut _));

                let invoke = || -> Result<bool, String> {
                    if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                        p.Invoke().map_err(gone)?;
                        return Ok(true);
                    }
                    if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                        p.Select().map_err(gone)?;
                        return Ok(true);
                    }
                    if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                        p.Toggle().map_err(gone)?;
                        return Ok(true);
                    }
                    if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
                        p.Expand().map_err(gone)?;
                        return Ok(true);
                    }
                    Ok(false)
                };

                match action {
                    "click" => {
                        if invoke()? {
                            std::thread::sleep(Duration::from_millis(250));
                            let still = e.CurrentBoundingRectangle().is_ok();
                            let fg = win::foreground().map(|w| w.title).unwrap_or_default();
                            return Ok(ActResult {
                                done: format!("Clicked {label}."),
                                verified: true,
                                detail: format!("The control accepted the click.{} Front window: \"{fg}\".", if still { "" } else { " It has now closed or disappeared" }),
                            });
                        }
                        // No automation pattern: a real click at its clickable point.
                        if let Some(why) = guard::game_blocks_input(crate::overlay::fullscreen_state()) {
                            return Err(why.into());
                        }
                        let mut pt = POINT::default();
                        let ok = e.GetClickablePoint(&mut pt).map(|b| b.as_bool()).unwrap_or(false);
                        if !ok {
                            let r = e.CurrentBoundingRectangle().map_err(gone)?;
                            pt = POINT { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
                        }
                        let _ = e.SetFocus();
                        input::click(pt.x, pt.y, false, false)?;
                        Ok(ActResult { done: format!("Clicked {label} with the mouse."), verified: false, detail: "It has no automation support, so BEV clicked its centre. Check the result if it matters.".into() })
                    }
                    "toggle" => {
                        let p = e.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).map_err(|_| format!("{label} can't be toggled."))?;
                        p.Toggle().map_err(gone)?;
                        std::thread::sleep(Duration::from_millis(150));
                        let s = p.CurrentToggleState().map(|s| s.0).unwrap_or(-1);
                        let st = match s {
                            1 => "on",
                            0 => "off",
                            2 => "mixed",
                            _ => "unknown",
                        };
                        Ok(ActResult { done: format!("Toggled {label}."), verified: s >= 0, detail: format!("It's now {st}.") })
                    }
                    "select" => {
                        let p = e.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId).map_err(|_| format!("{label} can't be selected."))?;
                        p.Select().map_err(gone)?;
                        std::thread::sleep(Duration::from_millis(150));
                        let sel = p.CurrentIsSelected().map(|b| b.as_bool()).unwrap_or(false);
                        Ok(ActResult { done: format!("Selected {label}."), verified: sel, detail: if sel { "It's selected.".into() } else { "It didn't report as selected.".into() } })
                    }
                    "expand" | "collapse" => {
                        let p = e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId).map_err(|_| format!("{label} can't be expanded or collapsed."))?;
                        (if action == "expand" { p.Expand() } else { p.Collapse() }).map_err(gone)?;
                        std::thread::sleep(Duration::from_millis(200));
                        let s = p.CurrentExpandCollapseState().map(|s| s.0).unwrap_or(-1);
                        let want = if action == "expand" { 1 } else { 0 };
                        Ok(ActResult { done: format!("{} {label}.", if action == "expand" { "Expanded" } else { "Collapsed" }), verified: s == want, detail: String::new() })
                    }
                    "focus" => {
                        e.SetFocus().map_err(gone)?;
                        Ok(ActResult { done: format!("Focused {label}."), verified: true, detail: String::new() })
                    }
                    "type" => {
                        let text = text.ok_or("Say what to type.")?;
                        if e.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false) {
                            return Err("That's a password box. BEV never types passwords: please enter it yourself.".into());
                        }
                        if let Some(why) = guard::typing_blocked(&process, &owner.class, &owner.title) {
                            return Err(why);
                        }
                        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                            if !p.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false) && p.SetValue(&BSTR::from(text)).is_ok() {
                                std::thread::sleep(Duration::from_millis(120));
                                let now = p.CurrentValue().map(|s| s.to_string()).unwrap_or_default();
                                let ok = now.trim() == text.trim();
                                return Ok(ActResult {
                                    done: format!("Typed into {label}."),
                                    verified: ok,
                                    detail: if ok { "The box now contains that text.".into() } else { "The box didn't read back the same text; check it.".into() },
                                });
                            }
                        }
                        // Fall back to focusing it and typing keystrokes.
                        if let Some(why) = guard::game_blocks_input(crate::overlay::fullscreen_state()) {
                            return Err(why.into());
                        }
                        e.SetFocus().map_err(gone)?;
                        std::thread::sleep(Duration::from_millis(80));
                        input::type_text(text)?;
                        Ok(ActResult { done: format!("Typed into {label}."), verified: false, detail: "Typed as keystrokes; this box can't be read back.".into() })
                    }
                    other => Err(format!("unknown action \"{other}\" (use click, toggle, select, expand, collapse, focus or type)")),
                }
            }
        }
    }
}

/// Linux: AT-SPI, mapped onto the same element list as Windows.
#[cfg(target_os = "linux")]
mod imp {
    use super::super::atspi::{self, bus};
    use super::super::elements;
    use super::super::{guard, input};
    use super::*;
    use crate::kwin::{self, KWindow};
    use std::sync::Mutex;
    use std::time::Duration;

    struct Last {
        refs: Vec<bus::Ref>,
        elements: Vec<elements::UiElement>,
        process: String,
    }
    static LAST: Mutex<Option<Last>> = Mutex::new(None);

    fn target(hwnd: Option<isize>) -> Result<KWindow, String> {
        let me = std::process::id();
        let list = kwin::windows()?;
        match hwnd {
            Some(h) => {
                let id = kwin::uuid_for(h).ok_or("that window isn't open any more")?;
                list.into_iter().find(|w| w.id == id).ok_or_else(|| "that window isn't open any more".into())
            }
            None => list
                .iter()
                .find(|w| w.active && w.pid != me && !w.min)
                .or_else(|| list.iter().find(|w| w.pid != me && !w.min && !w.title.is_empty()))
                .cloned()
                .ok_or_else(|| "There's no window to read.".into()),
        }
    }

    pub fn read(hwnd: Option<isize>) -> Result<UiSnapshot, String> {
        let w = target(hwnd)?;
        let (pid, title, cx, cy) = (w.pid, w.title.clone(), w.cx, w.cy);
        let walked = kwin::block(async move {
            let win = bus::window_for(pid, &title).await?;
            bus::walk(&win, cx, cy).await
        })?;
        let (picked, shaped, truncated) = elements::shape(&walked.raw);
        let process = w.process();
        if let Ok(mut g) = LAST.lock() {
            *g = Some(Last { refs: picked.iter().map(|&i| walked.refs[i].clone()).collect(), elements: shaped.clone(), process: process.clone() });
        }
        Ok(UiSnapshot { title: w.title.clone(), process, hwnd: w.handle(), elements: shaped, truncated })
    }

    pub fn act(id: usize, action: String, text: Option<String>) -> Result<ActResult, String> {
        let (r, el) = {
            let g = LAST.lock().map_err(|_| "lock")?;
            let last = g.as_ref().ok_or("Read the window first.")?;
            (last.refs.get(id).cloned().ok_or("That control isn't in the last reading. Read the window again.")?, last.elements[id].clone())
        };
        let label = if el.name.is_empty() { format!("the {}", el.role) } else { format!("\"{}\"", el.name) };
        match action.as_str() {
            "focus" => {
                let r2 = r.clone();
                kwin::block(async move { bus::grab_focus(&r2).await })?;
                Ok(ActResult { done: format!("Focused {label}."), verified: true, detail: String::new() })
            }
            "type" => {
                let text = text.ok_or("say what to type")?;
                if el.password {
                    return Err("That's a password box. BEV never types passwords: please enter it yourself.".into());
                }
                let (r2, t2) = (r.clone(), text.clone());
                let set = kwin::block(async move {
                    let ok = bus::set_text(&r2, &t2).await.unwrap_or(false);
                    let back = if ok { bus::get_text(&r2).await } else { None };
                    (ok, back)
                });
                if set.0 {
                    let ok = set.1.as_deref() == Some(text.as_str());
                    return Ok(ActResult { done: format!("Typed into {label}."), verified: ok, detail: if ok { "The box now contains that text.".into() } else { "The box didn't read back the same text; check it.".into() } });
                }
                if let Some(why) = guard::game_blocks_input(crate::overlay::fullscreen_state()) {
                    return Err(why.into());
                }
                let r2 = r.clone();
                kwin::block(async move { bus::grab_focus(&r2).await })?;
                std::thread::sleep(Duration::from_millis(80));
                input::type_text(&text)?;
                Ok(ActResult { done: format!("Typed into {label}."), verified: false, detail: "Typed as keystrokes; this box can't be read back.".into() })
            }
            verb @ ("click" | "toggle" | "select" | "expand" | "collapse") => {
                let (r2, v) = (r.clone(), verb.to_string());
                let done = kwin::block(async move {
                    let names = bus::action_names(&r2).await;
                    match atspi::pick_action(&names, &v) {
                        Some(i) => bus::do_action(&r2, i).await.map(Some),
                        None => Ok(None),
                    }
                })?;
                if done == Some(true) {
                    std::thread::sleep(Duration::from_millis(200));
                    let detail = if verb == "toggle" {
                        let r3 = r.clone();
                        let st = kwin::block(async move { bus::state_of(&r3).await });
                        format!("It's now {}.", if atspi::has(&st, 4) { "on" } else { "off" })
                    } else {
                        "The control accepted it.".into()
                    };
                    return Ok(ActResult { done: format!("{} {label}.", capital(verb)), verified: true, detail });
                }
                if verb != "click" && verb != "toggle" {
                    return Err(format!("{label} can't be {verb}ed."));
                }
                // No usable action: a real click on its centre.
                if let Some(why) = guard::game_blocks_input(crate::overlay::fullscreen_state()) {
                    return Err(why.into());
                }
                let [x, y, w, h] = el.rect;
                if w < 2 || h < 2 {
                    return Err(format!("{label} has no position to click."));
                }
                input::click(x + w / 2, y + h / 2, false, false)?;
                Ok(ActResult { done: format!("Clicked {label} with the mouse."), verified: false, detail: "It has no accessibility action, so BEV clicked its centre. Check the result if it matters.".into() })
            }
            other => Err(format!("unknown action \"{other}\" (use click, toggle, select, expand, collapse, focus or type)")),
        }
    }

    fn capital(s: &str) -> String {
        let past = match s {
            "click" => "Clicked",
            "toggle" => "Toggled",
            "select" => "Selected",
            "expand" => "Expanded",
            _ => "Collapsed",
        };
        past.to_string()
    }

    /// What's under a point, from the last reading (AT-SPI can't hit-test
    /// screen positions on Wayland).
    pub fn element_at(x: i32, y: i32) -> Result<Option<PointInfo>, String> {
        let g = LAST.lock().map_err(|_| "lock")?;
        let Some(last) = g.as_ref() else { return Ok(None) };
        Ok(last
            .elements
            .iter()
            .filter(|e| {
                let [l, t, w, h] = e.rect;
                x >= l && y >= t && x < l + w && y < t + h
            })
            .min_by_key(|e| e.rect[2] as i64 * e.rect[3] as i64)
            .map(|e| PointInfo { name: e.name.clone(), role: e.role, process: last.process.clone(), password: e.password }))
    }

    pub fn focused_is_password() -> Result<bool, String> {
        let Ok(w) = target(None) else { return Ok(false) };
        let (pid, title) = (w.pid, w.title);
        Ok(kwin::block(async move {
            match bus::window_for(pid, &title).await {
                Ok(win) => bus::focused_is_password(&win).await,
                Err(_) => false,
            }
        }))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::*;
    const NO: &str = "reading app controls isn't supported on this OS";
    pub fn read(_h: Option<isize>) -> Result<UiSnapshot, String> {
        Err(NO.into())
    }
    pub fn act(_i: usize, _a: String, _t: Option<String>) -> Result<ActResult, String> {
        Err(NO.into())
    }
    pub fn element_at(_x: i32, _y: i32) -> Result<Option<PointInfo>, String> {
        Ok(None)
    }
    pub fn focused_is_password() -> Result<bool, String> {
        Ok(false)
    }
}

pub use imp::*;
