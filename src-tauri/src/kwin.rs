//! Windows on KDE Plasma (Wayland). Wayland has no API for one app to see
//! or move another's windows, so BEV asks KWin: it loads a tiny KWin script
//! that does the job and sends the answer back to BEV over D-Bus.

#![cfg(target_os = "linux")]

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const BUS_NAME: &str = "org.cbevss.BEV";
const PATH: &str = "/kwin";
const IFACE: &str = "org.cbevss.BEV.KWin";

static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static CONN: tokio::sync::OnceCell<zbus::Connection> = tokio::sync::OnceCell::const_new();
static PENDING: Mutex<Option<HashMap<String, tokio::sync::oneshot::Sender<String>>>> = Mutex::new(None);
static HANDLES: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct Reporter;

#[zbus::interface(name = "org.cbevss.BEV.KWin")]
impl Reporter {
    fn report(&self, id: String, json: String) {
        if let Some(tx) = PENDING.lock().ok().and_then(|mut p| p.as_mut().and_then(|m| m.remove(&id))) {
            let _ = tx.send(json);
        }
    }
}

fn rt() -> &'static tokio::runtime::Runtime {
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(1).thread_name("bev-kwin").enable_all().build().expect("kwin runtime")
    })
}

/// Run async work from any thread (including ones inside Tauri's runtime).
pub(crate) fn block<T: Send + 'static>(f: impl std::future::Future<Output = T> + Send + 'static) -> T {
    std::thread::spawn(move || rt().block_on(f)).join().expect("kwin thread")
}

async fn conn() -> Result<&'static zbus::Connection, String> {
    CONN.get_or_try_init(|| async {
        zbus::connection::Builder::session()
            .and_then(|b| b.name(BUS_NAME))
            .and_then(|b| b.serve_at(PATH, Reporter))
            .map_err(|e| e.to_string())?
            .build()
            .await
            .map_err(|e| format!("D-Bus: {e}"))
    })
    .await
}

/// Wrap a script body (which `return`s a value) so KWin sends the result back.
pub fn wrap(id: &str, body: &str) -> String {
    format!(
        "(function(){{var r;try{{r=(function(){{\n{HELPERS}\n{body}\n}})();}}catch(e){{r={{error:String(e)}};}}\
callDBus(\"{BUS_NAME}\",\"{PATH}\",\"{IFACE}\",\"Report\",\"{id}\",JSON.stringify(r===undefined?null:r));}})();"
    )
}

const HELPERS: &str = r#"
function screens(){return workspace.screens;}
function d(w){var g=w.frameGeometry;var s=screens();var i=w.output?s.indexOf(w.output):-1;
return {id:String(w.internalId),title:String(w.caption||""),cls:String(w.resourceClass||""),pid:w.pid||0,
min:!!w.minimized,normal:!!(w.normalWindow&&!w.skipTaskbar),x:Math.round(g.x),y:Math.round(g.y),w:Math.round(g.width),h:Math.round(g.height),
screen:i,screens:s.length,active:workspace.activeWindow===w,cx:Math.round(w.clientGeometry?w.clientGeometry.x:g.x),cy:Math.round(w.clientGeometry?w.clientGeometry.y:g.y)};}
function all(){return workspace.windowList().filter(function(w){return w.normalWindow&&!w.skipTaskbar;});}
function byId(id){var l=workspace.windowList();for(var i=0;i<l.length;i++){if(String(l[i].internalId)===id)return l[i];}return null;}
"#;

/// Run a KWin script body and return what it sent back.
pub fn script(body: &str) -> Result<serde_json::Value, String> {
    let body = body.to_string();
    block(async move {
        let c = conn().await?;
        let id = format!("{}{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let path = std::env::temp_dir().join(format!("bev-kwin-{id}.js"));
        std::fs::write(&path, wrap(&id, &body)).map_err(|e| e.to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        PENDING.lock().map_err(|_| "kwin lock")?.get_or_insert_with(HashMap::new).insert(id.clone(), tx);
        let name = format!("bev-{id}");
        let result = async {
            let reply = c
                .call_method(Some("org.kde.KWin"), "/Scripting", Some("org.kde.kwin.Scripting"), "loadScript", &(path.to_string_lossy().as_ref(), name.as_str()))
                .await
                .map_err(|e| format!("KWin isn't available ({e}). BEV's window control needs KDE Plasma."))?;
            let sid: i32 = reply.body().deserialize().map_err(|e| e.to_string())?;
            if sid < 0 {
                return Err("KWin refused BEV's script".to_string());
            }
            // Plasma 6 exposes /Scripting/Script<N>; older builds use /<N>.
            let obj = format!("/Scripting/Script{sid}");
            if c.call_method(Some("org.kde.KWin"), obj.as_str(), Some("org.kde.kwin.Script"), "run", &()).await.is_err() {
                let old = format!("/{sid}");
                c.call_method(Some("org.kde.KWin"), old.as_str(), Some("org.kde.kwin.Script"), "run", &()).await.map_err(|e| e.to_string())?;
            }
            let json = tokio::time::timeout(Duration::from_secs(3), rx).await.map_err(|_| "KWin didn't answer".to_string())?.map_err(|_| "KWin didn't answer".to_string())?;
            serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())
        }
        .await;
        let _ = c.call_method(Some("org.kde.KWin"), "/Scripting", Some("org.kde.kwin.Scripting"), "unloadScript", &(name.as_str(),)).await;
        let _ = std::fs::remove_file(&path);
        if let Ok(mut p) = PENDING.lock() {
            if let Some(m) = p.as_mut() {
                m.remove(&id);
            }
        }
        let v = result?;
        if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
            return Err(format!("KWin: {e}"));
        }
        Ok(v)
    })
}

#[derive(Deserialize, Debug, Clone)]
pub struct KWindow {
    pub id: String,
    pub title: String,
    pub cls: String,
    pub pid: u32,
    pub min: bool,
    pub normal: bool,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub screen: i32,
    pub screens: i32,
    pub active: bool,
    /// Top-left of the window's content (inside the title bar).
    #[serde(default)]
    pub cx: i32,
    #[serde(default)]
    pub cy: i32,
}

impl KWindow {
    /// A stable small number for the window (Windows code calls it an HWND).
    pub fn handle(&self) -> isize {
        handle_for(&self.id)
    }
    pub fn process(&self) -> String {
        process_name(self.pid).unwrap_or_else(|| self.cls.clone())
    }
}

pub fn handle_for(uuid: &str) -> isize {
    let mut h = HANDLES.lock().unwrap();
    if let Some(i) = h.iter().position(|u| u == uuid) {
        return i as isize + 1;
    }
    h.push(uuid.to_string());
    h.len() as isize
}

pub fn uuid_for(handle: isize) -> Option<String> {
    HANDLES.lock().ok()?.get((handle - 1).max(0) as usize).cloned().filter(|_| handle > 0)
}

pub fn process_name(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    std::fs::read_to_string(format!("/proc/{pid}/comm")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn parse_list(v: serde_json::Value) -> Result<Vec<KWindow>, String> {
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// Normal app windows, top of the stack first.
pub fn windows() -> Result<Vec<KWindow>, String> {
    let mut l = parse_list(script("var s=workspace.stackingOrder.filter(function(w){return w.normalWindow&&!w.skipTaskbar;});return s.reverse().map(d);")?)?;
    l.retain(|w| w.normal);
    Ok(l)
}

pub fn active() -> Result<Option<KWindow>, String> {
    let v = script("var w=workspace.activeWindow;return w?d(w):null;")?;
    if v.is_null() {
        return Ok(None);
    }
    serde_json::from_value(v).map(Some).map_err(|e| e.to_string())
}

fn act(handle: isize, js: &str) -> Result<(), String> {
    let id = uuid_for(handle).ok_or("that window isn't open any more")?;
    let id_js = serde_json::to_string(&id).unwrap_or_default();
    let v = script(&format!("var w=byId({id_js});if(!w)return {{error:'that window isn\\'t open any more'}};{js}return true;"))?;
    if v == serde_json::Value::Bool(true) {
        Ok(())
    } else {
        Err("KWin didn't do it".into())
    }
}

pub fn focus(handle: isize) -> Result<(), String> {
    act(handle, "if(w.minimized)w.minimized=false;workspace.activeWindow=w;")
}

/// state: "normal" | "maximized" | "minimized".
pub fn place(handle: isize, x: i32, y: i32, w: i32, h: i32, state: &str) -> Result<(), String> {
    let js = match state {
        "minimized" => "w.minimized=true;".to_string(),
        "maximized" => "w.minimized=false;w.setMaximize(true,true);".to_string(),
        _ => format!("w.minimized=false;w.setMaximize(false,false);w.frameGeometry={{x:{x},y:{y},width:{w},height:{h}}};"),
    };
    act(handle, &js)
}

#[derive(Deserialize, Debug, Clone)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub primary: bool,
}

/// Each screen's usable area (without panels).
pub fn work_areas() -> Result<Vec<Area>, String> {
    let v = script(
        "var s=screens();return s.map(function(o,i){var a=workspace.clientArea(KWin.MaximizeArea,o,workspace.currentDesktop);\
return {x:Math.round(a.x),y:Math.round(a.y),w:Math.round(a.width),h:Math.round(a.height),primary:i===0};});",
    )?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_script_with_report_call() {
        let s = wrap("42", "return 1;");
        assert!(s.contains("return 1;"));
        assert!(s.contains("\"Report\",\"42\""));
        assert!(s.contains("callDBus(\"org.cbevss.BEV\",\"/kwin\""));
    }
    #[test]
    fn handles_are_stable() {
        let a = handle_for("{aaa}");
        let b = handle_for("{bbb}");
        assert_ne!(a, b);
        assert_eq!(handle_for("{aaa}"), a);
        assert_eq!(uuid_for(a).as_deref(), Some("{aaa}"));
        assert_eq!(uuid_for(0), None);
    }
}

/// Turn KWin's raw screenshot bytes into RGBA. `format` is a QImage::Format.
pub fn raw_to_rgba(data: &[u8], width: u32, height: u32, stride: u32, format: u32) -> Option<image::RgbaImage> {
    let (w, h, s) = (width as usize, height as usize, stride as usize);
    if w == 0 || h == 0 || s < w * 4 || data.len() < s * (h - 1) + w * 4 {
        return None;
    }
    let mut out = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let line = &data[row * s..row * s + w * 4];
        for px in line.chunks_exact(4) {
            match format {
                // RGB32 / ARGB32 / ARGB32_Premultiplied: 0xAARRGGBB, little-endian → B G R A.
                4 => out.extend_from_slice(&[px[2], px[1], px[0], 255]),
                5 | 6 => out.extend_from_slice(&[px[2], px[1], px[0], px[3]]),
                // RGBX8888 / RGBA8888(_Premultiplied): bytes already R G B A.
                16 => out.extend_from_slice(&[px[0], px[1], px[2], 255]),
                17 | 18 => out.extend_from_slice(px),
                _ => return None,
            }
        }
    }
    image::RgbaImage::from_raw(width, height, out)
}

/// Capture one screen (by connector name, e.g. "DP-1") through KWin's
/// ScreenShot2 interface. Works silently because BEV's .desktop file lists
/// it in X-KDE-DBUS-Restricted-Interfaces; errors otherwise.
pub fn capture_screen(name: &str) -> Result<image::RgbaImage, String> {
    use std::io::Read;
    use zbus::zvariant::{Fd, OwnedValue};
    let name = name.to_string();
    block(async move {
        let c = conn().await?;
        let (mut ours, theirs) = std::os::unix::net::UnixStream::pair().map_err(|e| e.to_string())?;
        // Read concurrently: KWin may write more than a socket buffer holds.
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            ours.read_to_end(&mut buf).map(|_| buf)
        });
        let mut opts: HashMap<&str, zbus::zvariant::Value> = HashMap::new();
        opts.insert("include-cursor", false.into());
        opts.insert("native-resolution", false.into());
        let reply = c
            .call_method(Some("org.kde.KWin"), "/org/kde/KWin/ScreenShot2", Some("org.kde.KWin.ScreenShot2"), "CaptureScreen", &(name.as_str(), opts, Fd::from(&theirs)))
            .await;
        drop(theirs);
        let reply = reply.map_err(|e| format!("KWin screenshot: {e}"))?;
        let meta: HashMap<String, OwnedValue> = reply.body().deserialize().map_err(|e| e.to_string())?;
        let num = |k: &str| meta.get(k).and_then(|v| u32::try_from(v).ok()).unwrap_or(0);
        let (w, h, stride, fmt) = (num("width"), num("height"), num("stride"), num("format"));
        let data = tokio::task::spawn_blocking(move || reader.join()).await.map_err(|e| e.to_string())?.map_err(|_| "reader".to_string())?.map_err(|e| e.to_string())?;
        raw_to_rgba(&data, w, h, stride, fmt).ok_or_else(|| format!("unexpected screenshot format {fmt}"))
    })
}

#[cfg(test)]
mod capture_tests {
    use super::raw_to_rgba;
    #[test]
    fn converts_argb32_with_stride() {
        // 1x2 image, stride 8 (4 bytes padding per row).
        let data = [3, 2, 1, 255, 0, 0, 0, 0, 30, 20, 10, 128, 0, 0, 0, 0];
        let img = raw_to_rgba(&data, 1, 2, 8, 5).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [1, 2, 3, 255]);
        assert_eq!(img.get_pixel(0, 1).0, [10, 20, 30, 128]);
        assert!(raw_to_rgba(&data, 1, 2, 8, 99).is_none());
    }
}

/// Control media players over MPRIS (Spotify, browsers, VLC…): no prompt
/// needed. `method`: PlayPause | Next | Previous | Stop. Prefers the player
/// that's currently playing.
pub fn mpris(method: &str) -> Result<String, String> {
    let method = method.to_string();
    block(async move {
        let c = conn().await?;
        let names: Vec<String> = c
            .call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "ListNames", &())
            .await
            .map_err(|e| e.to_string())?
            .body()
            .deserialize()
            .map_err(|e| e.to_string())?;
        let players: Vec<String> = names.into_iter().filter(|n| n.starts_with("org.mpris.MediaPlayer2.")).collect();
        if players.is_empty() {
            return Err("no media player is open".into());
        }
        let mut chosen = players[0].clone();
        for p in &players {
            let st = c
                .call_method(Some(p.as_str()), "/org/mpris/MediaPlayer2", Some("org.freedesktop.DBus.Properties"), "Get", &("org.mpris.MediaPlayer2.Player", "PlaybackStatus"))
                .await
                .ok()
                .and_then(|r| r.body().deserialize::<zbus::zvariant::OwnedValue>().ok())
                .and_then(|v| String::try_from(v).ok());
            if st.as_deref() == Some("Playing") {
                chosen = p.clone();
                break;
            }
        }
        c.call_method(Some(chosen.as_str()), "/org/mpris/MediaPlayer2", Some("org.mpris.MediaPlayer2.Player"), method.as_str(), &())
            .await
            .map_err(|e| e.to_string())?;
        Ok(chosen.trim_start_matches("org.mpris.MediaPlayer2.").split('.').next().unwrap_or("player").to_string())
    })
}

#[derive(Debug, Clone)]
pub struct Display {
    pub path: String,
    pub label: String,
    pub brightness: i32,
    pub max: i32,
}

/// Screens whose brightness Plasma can change (laptop panels, and DDC/CI
/// monitors through PowerDevil). Needs Plasma 6.1 or newer.
pub fn displays() -> Result<Vec<Display>, String> {
    block(async move {
        let c = conn().await?;
        let get = |path: String, prop: &'static str| async move {
            c.call_method(Some("org.kde.ScreenBrightness"), path.as_str(), Some("org.freedesktop.DBus.Properties"), "Get", &(if prop == "DisplaysDBusNames" { "org.kde.ScreenBrightness" } else { "org.kde.ScreenBrightness.Display" }, prop))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.body().deserialize::<zbus::zvariant::OwnedValue>().map_err(|e| e.to_string()))
        };
        let names: Vec<String> = get("/org/kde/ScreenBrightness".into(), "DisplaysDBusNames")
            .await
            .map_err(|_| "Plasma's brightness service isn't available (needs Plasma 6.1+)".to_string())
            .and_then(|v| Vec::<String>::try_from(v).map_err(|e| e.to_string()))?;
        let mut out = Vec::new();
        for n in names {
            let path = format!("/org/kde/ScreenBrightness/{n}");
            let label = get(path.clone(), "Label").await.ok().and_then(|v| String::try_from(v).ok()).unwrap_or_else(|| n.clone());
            let brightness = get(path.clone(), "Brightness").await.ok().and_then(|v| i32::try_from(v).ok()).unwrap_or(0);
            let max = get(path.clone(), "MaxBrightness").await.ok().and_then(|v| i32::try_from(v).ok()).unwrap_or(0);
            out.push(Display { path, label, brightness, max });
        }
        Ok(out)
    })
}

pub fn set_display_brightness(path: &str, value: i32) -> Result<(), String> {
    let path = path.to_string();
    block(async move {
        let c = conn().await?;
        // flags 0x1 = SuppressIndicator off → Plasma shows its OSD.
        c.call_method(Some("org.kde.ScreenBrightness"), path.as_str(), Some("org.kde.ScreenBrightness.Display"), "SetBrightness", &(value, 0u32))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
}

/// Power profiles over D-Bus (power-profiles-daemon and Fedora's tuned-ppd
/// both serve this). Returns (profile ids, active id).
pub fn power_profiles() -> Result<(Vec<String>, String), String> {
    block(async move {
        let c = system_conn().await?;
        let get = |prop: &'static str| async move {
            c.call_method(Some("org.freedesktop.UPower.PowerProfiles"), "/org/freedesktop/UPower/PowerProfiles", Some("org.freedesktop.DBus.Properties"), "Get", &("org.freedesktop.UPower.PowerProfiles", prop))
                .await
                .map_err(|e| format!("power profiles aren't available ({e})"))
                .and_then(|r| r.body().deserialize::<zbus::zvariant::OwnedValue>().map_err(|e| e.to_string()))
        };
        let active = String::try_from(get("ActiveProfile").await?).map_err(|e| e.to_string())?;
        let list: Vec<HashMap<String, zbus::zvariant::OwnedValue>> = get("Profiles").await?.try_into().map_err(|e: zbus::zvariant::Error| e.to_string())?;
        let ids = list.into_iter().filter_map(|m| m.get("Profile").and_then(|v| String::try_from(v.clone()).ok())).collect();
        Ok((ids, active))
    })
}

pub fn set_power_profile(id: &str) -> Result<(), String> {
    let id = id.to_string();
    block(async move {
        let c = system_conn().await?;
        c.call_method(
            Some("org.freedesktop.UPower.PowerProfiles"),
            "/org/freedesktop/UPower/PowerProfiles",
            Some("org.freedesktop.DBus.Properties"),
            "Set",
            &("org.freedesktop.UPower.PowerProfiles", "ActiveProfile", zbus::zvariant::Value::from(id.as_str())),
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
}

static SYS: tokio::sync::OnceCell<zbus::Connection> = tokio::sync::OnceCell::const_new();

async fn system_conn() -> Result<&'static zbus::Connection, String> {
    SYS.get_or_try_init(|| async { zbus::Connection::system().await.map_err(|e| format!("system D-Bus: {e}")) }).await
}
