//! WhatsApp linked device: runs the bundled bev-wa helper (resources/binaries) and
//! passes JSON lines between it and the app. Events (QR code, ready, new message)
//! go to the UI as "wa-event"; requests wait for their reply.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Helper {
    child: Child,
    stdin: ChildStdin,
}

static HELPER: OnceLock<Mutex<Option<Helper>>> = OnceLock::new();
static PENDING: OnceLock<Mutex<HashMap<String, Sender<Value>>>> = OnceLock::new();
static NEXT: OnceLock<Mutex<u64>> = OnceLock::new();

fn helper() -> &'static Mutex<Option<Helper>> {
    HELPER.get_or_init(|| Mutex::new(None))
}
fn pending() -> &'static Mutex<HashMap<String, Sender<Value>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Is a line from the helper a reply to a request (vs an event)? Pure; tested.
pub fn reply_id(line: &Value) -> Option<String> {
    line.get("reply").and_then(|v| v.as_str()).map(str::to_string)
}

fn exe_name() -> &'static str {
    if cfg!(windows) { "bev-wa.exe" } else { "bev-wa" }
}

fn find_exe(app: &AppHandle) -> Option<std::path::PathBuf> {
    let mut places = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        places.push(res.join("binaries").join(exe_name()));
    }
    places.push(std::path::PathBuf::from("binaries").join(exe_name())); // tauri dev
    places.into_iter().find(|p| p.exists())
}

fn running() -> bool {
    let mut guard = helper().lock().unwrap();
    match guard.as_mut() {
        Some(h) => matches!(h.child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Start the helper (if it isn't already). It signs in with the saved login, or sends a QR event.
#[tauri::command]
pub fn wa_link_start(app: AppHandle) -> Result<bool, String> {
    if running() {
        return Ok(true);
    }
    let exe = find_exe(&app).ok_or("BEV's WhatsApp helper is missing from this install.")?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?.join("whatsapp");
    let mut cmd = Command::new(exe);
    cmd.arg("-data").arg(&data).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start the WhatsApp helper: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    *helper().lock().unwrap() = Some(Helper { child, stdin });
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(id) = reply_id(&value) {
                if let Some(tx) = pending().lock().unwrap().remove(&id) {
                    let _ = tx.send(value);
                }
            } else {
                let _ = app.emit("wa-event", value);
            }
        }
        let _ = app.emit("wa-event", json!({"event": "stopped"}));
    });
    Ok(true)
}

/// Send a request ({"cmd":"send",...}) to the helper and wait for its reply.
#[tauri::command]
pub async fn wa_link_request(request: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !running() {
            return Err("WhatsApp isn't linked to BEV right now.".to_string());
        }
        let id = {
            let mut n = NEXT.get_or_init(|| Mutex::new(0)).lock().unwrap();
            *n += 1;
            n.to_string()
        };
        let (tx, rx) = channel();
        pending().lock().unwrap().insert(id.clone(), tx);
        let mut req = request;
        req["id"] = json!(id);
        {
            let mut guard = helper().lock().unwrap();
            let h = guard.as_mut().ok_or("not running")?;
            writeln!(h.stdin, "{req}").and_then(|_| h.stdin.flush()).map_err(|e| e.to_string())?;
        }
        let answer = rx.recv_timeout(Duration::from_secs(30)).map_err(|_| {
            pending().lock().unwrap().remove(&id);
            "WhatsApp didn't answer in time.".to_string()
        })?;
        if answer.get("ok").and_then(|v| v.as_bool()) == Some(true) {
            Ok(answer.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(answer.get("error").and_then(|v| v.as_str()).unwrap_or("WhatsApp said no.").to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn wa_link_running() -> bool {
    running()
}

/// Stop the helper (the login stays saved).
#[tauri::command]
pub fn wa_link_stop() {
    if let Some(mut h) = helper().lock().unwrap().take() {
        let _ = h.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tells_replies_from_events() {
        assert_eq!(reply_id(&json!({"reply":"3","ok":true})), Some("3".into()));
        assert_eq!(reply_id(&json!({"event":"qr"})), None);
    }
}
