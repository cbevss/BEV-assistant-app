//! Keyboard and mouse on Wayland through the xdg-desktop-portal RemoteDesktop
//! interface (xdg-desktop-portal-kde on Plasma). The first use shows Plasma's
//! "allow remote control" prompt; the portal's restore token is saved so it
//! isn't asked again until the user revokes it.
//!
//! One worker thread owns the portal session; callers send batches of input
//! events and wait for the result.

#![cfg(target_os = "linux")]

use ashpd::desktop::remote_desktop::{Axis, DeviceType, KeyState, RemoteDesktop};
use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};
use ashpd::desktop::PersistMode;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[derive(Debug, Clone)]
pub enum Op {
    Key(i32, bool),
    Keysym(i32, bool),
    /// Absolute desktop position (logical pixels).
    Move(i32, i32),
    Button(i32, bool),
    /// Discrete wheel steps; positive = down/right.
    Scroll { horizontal: bool, steps: i32 },
    Sleep(u64),
}

pub const BTN_LEFT: i32 = 0x110;
pub const BTN_RIGHT: i32 = 0x111;

type Job = (Vec<Op>, mpsc::Sender<Result<(), String>>);

static WORKER: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();
/// Where BEV last put the pointer (the portal can't read the real cursor).
pub static LAST_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

fn token_path() -> std::path::PathBuf {
    crate::linux::config_dir().join("bev").join("portal-remote-desktop.token")
}

/// Send input events and wait until they've been delivered.
pub fn send(ops: Vec<Op>) -> Result<(), String> {
    let tx = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("bev-portal".into())
            .spawn(move || worker(rx))
            .expect("spawn portal worker");
        Mutex::new(tx)
    });
    let (rtx, rrx) = mpsc::channel();
    tx.lock().map_err(|_| "input worker is unavailable")?.send((ops, rtx)).map_err(|_| "input worker stopped")?;
    // The first call may wait on the user answering Plasma's prompt.
    rrx.recv_timeout(Duration::from_secs(120)).map_err(|_| "Plasma didn't answer the remote control request".to_string())?
}

/// Which portal stream holds a desktop point, and the point relative to it.
pub fn locate(streams: &[(u32, Option<(i32, i32)>, Option<(i32, i32)>)], x: i32, y: i32) -> Option<(u32, f64, f64)> {
    for &(id, pos, size) in streams {
        if let (Some((px, py)), Some((w, h))) = (pos, size) {
            if x >= px && y >= py && x < px + w && y < py + h {
                return Some((id, (x - px) as f64, (y - py) as f64));
            }
        }
    }
    // Single monitor with no layout info: coordinates are already local.
    match streams {
        [(id, None, _)] => Some((*id, x as f64, y as f64)),
        _ => None,
    }
}

fn worker(rx: mpsc::Receiver<Job>) {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            for (_, reply) in rx {
                let _ = reply.send(Err(format!("input runtime: {e}")));
            }
            return;
        }
    };
    rt.block_on(async move {
        // Reconnect after any session failure (user revoked access, portal restarted).
        let mut pending: Option<Job> = None;
        loop {
            let job = match pending.take() {
                Some(j) => j,
                None => match rx.recv() {
                    Ok(j) => j,
                    Err(_) => return,
                },
            };
            match session_loop(&rx, job).await {
                Ok(()) => return,
                Err((e, leftover)) => {
                    if let Some((_, reply)) = leftover {
                        let _ = reply.send(Err(e));
                    }
                }
            }
        }
    });
}

type Fail = (String, Option<Job>);

async fn session_loop(rx: &mpsc::Receiver<Job>, first: Job) -> Result<(), Fail> {
    let err = |job: Job| move |e: ashpd::Error| (format!("remote control: {e}"), Some(job));
    let rd = match RemoteDesktop::new().await {
        Ok(rd) => rd,
        Err(e) => return Err(err(first)(e)),
    };
    let sc = match Screencast::new().await {
        Ok(sc) => sc,
        Err(e) => return Err(err(first)(e)),
    };
    let session = match rd.create_session().await {
        Ok(s) => s,
        Err(e) => return Err(err(first)(e)),
    };
    let saved = std::fs::read_to_string(token_path()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Err(e) = rd
        .select_devices(&session, DeviceType::Keyboard | DeviceType::Pointer, saved.as_deref(), PersistMode::ExplicitlyRevoked)
        .await
    {
        return Err(err(first)(e));
    }
    // Monitor streams give BEV absolute pointer positions on every screen.
    if let Err(e) = sc.select_sources(&session, CursorMode::Hidden, SourceType::Monitor.into(), true, None, PersistMode::DoNot).await {
        return Err(err(first)(e));
    }
    let started = match rd.start(&session, None).await.and_then(|r| r.response()) {
        Ok(r) => r,
        Err(_) => return Err(("You didn't allow BEV to control the PC (Plasma's remote control prompt).".into(), Some(first))),
    };
    if let Some(tok) = started.restore_token() {
        let p = token_path();
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&p, tok);
    }
    let streams: Vec<(u32, Option<(i32, i32)>, Option<(i32, i32)>)> = started
        .streams()
        .unwrap_or(&[])
        .iter()
        .map(|s| (s.pipe_wire_node_id(), s.position(), s.size()))
        .collect();

    let mut job = first;
    loop {
        let (ops, reply) = job;
        let mut result = Ok(());
        for op in ops {
            let r = match op {
                Op::Key(code, down) => rd.notify_keyboard_keycode(&session, code, state(down)).await,
                Op::Keysym(sym, down) => rd.notify_keyboard_keysym(&session, sym, state(down)).await,
                Op::Button(b, down) => rd.notify_pointer_button(&session, b, state(down)).await,
                Op::Scroll { horizontal, steps } => {
                    let axis = if horizontal { Axis::Horizontal } else { Axis::Vertical };
                    rd.notify_pointer_axis_discrete(&session, axis, steps).await
                }
                Op::Move(x, y) => match locate(&streams, x, y) {
                    Some((id, lx, ly)) => {
                        let r = rd.notify_pointer_motion_absolute(&session, id, lx, ly).await;
                        if r.is_ok() {
                            if let Ok(mut g) = LAST_POS.lock() {
                                *g = Some((x, y));
                            }
                        }
                        r
                    }
                    None => {
                        result = Err(format!("({x}, {y}) isn't on any screen"));
                        break;
                    }
                },
                Op::Sleep(ms) => {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    Ok(())
                }
            };
            if let Err(e) = r {
                // The session is gone (revoked or the portal restarted): start over next time.
                let _ = reply.send(Err(format!("remote control stopped: {e}")));
                return Err((String::new(), None));
            }
        }
        let _ = reply.send(result);
        job = match rx.recv() {
            Ok(j) => j,
            Err(_) => return Ok(()),
        };
    }
}

fn state(down: bool) -> KeyState {
    if down {
        KeyState::Pressed
    } else {
        KeyState::Released
    }
}

#[cfg(test)]
mod tests {
    use super::locate;
    #[test]
    fn finds_the_right_monitor() {
        let s = [(10, Some((0, 0)), Some((1920, 1080))), (11, Some((1920, 0)), Some((1280, 1024)))];
        assert_eq!(locate(&s, 100, 100), Some((10, 100.0, 100.0)));
        assert_eq!(locate(&s, 2000, 50), Some((11, 80.0, 50.0)));
        assert_eq!(locate(&s, 5000, 50), None);
        assert_eq!(locate(&[(7, None, None)], 30, 40), Some((7, 30.0, 40.0)));
    }
}
