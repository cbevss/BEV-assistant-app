//! Plumbing for connectors (Home Assistant, GitHub, Spotify, Google, MCP):
//! HTTP to the user's own services, the OAuth loopback for sign-in, and MCP
//! servers that run as local programs. No credentials are logged; tokens are
//! kept in the OS keyring (secrets.rs) and passed in per request by the app.

use crate::error::{BevError, BevResult};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

// ---------------------------------------------------------------------------
// HTTP

/// Public APIs connectors use. Anything else (a Home Assistant box, a remote
/// MCP server) must be added by the user in BEV's settings first.
const KNOWN: &[&str] = &[
    "https://api.github.com",
    "https://api.spotify.com",
    "https://accounts.spotify.com",
    "https://www.googleapis.com",
    "https://gmail.googleapis.com",
    "https://oauth2.googleapis.com",
    "https://api.search.brave.com",
    "https://discord.com",
];

/// scheme://host[:port], lower-cased; None if it isn't an http(s) URL.
pub fn origin_of(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    if host.is_empty() || host.contains('@') {
        return None; // no credentials in URLs
    }
    Some(format!("{scheme}://{host}"))
}

pub fn allowed(url: &str, user: &HashSet<String>) -> bool {
    match origin_of(url) {
        Some(o) => KNOWN.contains(&o.as_str()) || user.contains(&o),
        None => false,
    }
}

fn user_origins() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

fn origins_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("integration-origins.json"))
}

pub fn load_origins(app: &tauri::AppHandle) {
    if let Some(p) = origins_file(app) {
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&s) {
                *user_origins().lock().unwrap() = v.into_iter().collect();
            }
        }
    }
}

fn save_origins(app: &tauri::AppHandle) {
    if let Some(p) = origins_file(app) {
        let v: Vec<String> = user_origins().lock().unwrap().iter().cloned().collect();
        let _ = std::fs::write(p, serde_json::to_string(&v).unwrap_or_default());
    }
}

/// Called from BEV's settings when the user saves a connector address.
#[tauri::command]
pub fn integration_allow_origin(app: tauri::AppHandle, url: String) -> BevResult<String> {
    let o = origin_of(&url).ok_or_else(|| BevError::Invalid("that isn't an http(s) address".into()))?;
    user_origins().lock().unwrap().insert(o.clone());
    save_origins(&app);
    Ok(o)
}

#[tauri::command]
pub fn integration_forget_origin(app: tauri::AppHandle, url: String) -> BevResult<()> {
    if let Some(o) = origin_of(&url) {
        user_origins().lock().unwrap().remove(&o);
        save_origins(&app);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct HttpReply {
    pub status: u16,
    /// Response headers, lower-cased names (used for MCP session ids).
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub content_type: String,
}

const MAX_BODY: usize = 2 * 1024 * 1024;

#[tauri::command]
pub async fn integration_fetch(url: String, method: Option<String>, headers: Option<Vec<(String, String)>>, body: Option<String>) -> BevResult<HttpReply> {
    if !allowed(&url, &user_origins().lock().unwrap()) {
        return Err(BevError::Message(format!("BEV isn't set up to talk to {}. Add it in Integrations first.", origin_of(&url).unwrap_or_else(|| "that address".into()))));
    }
    // Some APIs (GitHub) refuse requests without a User-Agent. A connector can
    // still send its own; this is only the default.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("BEV/", env!("CARGO_PKG_VERSION"), " (personal assistant; +https://github.com/cbevss/BEV-assistant-app)"))
        .build()
        .map_err(|e| BevError::Os(e.to_string()))?;
    let m = reqwest::Method::from_bytes(method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_bytes()).map_err(|_| BevError::Invalid("bad method".into()))?;
    let mut req = client.request(m, &url);
    for (k, v) in headers.unwrap_or_default() {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| BevError::Message(format!("couldn't reach {}: {}", origin_of(&url).unwrap_or_default(), e.without_url())))?;
    let status = res.status().as_u16();
    let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let headers = res.headers().iter().filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_ascii_lowercase(), v.to_string()))).collect();
    let bytes = res.bytes().await.map_err(|e| BevError::Os(e.without_url().to_string()))?;
    let body = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_BODY)]).into_owned();
    Ok(HttpReply { status, headers, body, content_type })
}

// ---------------------------------------------------------------------------
// OAuth loopback (RFC 8252): the browser redirects to 127.0.0.1:<port>.

fn listeners() -> &'static Mutex<HashMap<u16, std::net::TcpListener>> {
    static S: OnceLock<Mutex<HashMap<u16, std::net::TcpListener>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cancel flags for sign-ins that are waiting on a port.
fn waits() -> &'static Mutex<HashMap<u16, std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    static S: OnceLock<Mutex<HashMap<u16, std::sync::Arc<std::sync::atomic::AtomicBool>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Open a one-shot listener (a fixed port if the service needs one); returns the port.
/// Starting a sign-in again replaces BEV's own earlier attempt on that port
/// (one left waiting, or one whose browser never opened) instead of failing.
#[tauri::command]
pub fn oauth_listen(port: Option<u16>) -> BevResult<u16> {
    if let Some(p) = port {
        listeners().lock().unwrap().remove(&p); // dropping it frees the port
        if let Some(flag) = waits().lock().unwrap().remove(&p) {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    // A cancelled wait notices within ~150ms and drops its listener; give it a moment.
    let mut tries = 0;
    let l = loop {
        match std::net::TcpListener::bind(("127.0.0.1", port.unwrap_or(0))) {
            Ok(l) => break l,
            Err(e) if port.is_some() && e.kind() == std::io::ErrorKind::AddrInUse && tries < 15 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let busy = e.kind() == std::io::ErrorKind::AddrInUse;
                return Err(BevError::Message(format!(
                    "couldn't open the sign-in port{}: {}",
                    port.map(|p| format!(" {p}")).unwrap_or_default(),
                    if busy { "another program is using it. Close it (or restart BEV) and try again".to_string() } else { e.to_string() }
                )));
            }
        }
    };
    let port = l.local_addr().map_err(|e| BevError::Os(e.to_string()))?.port();
    listeners().lock().unwrap().insert(port, l);
    Ok(port)
}

/// The query string from the first request to /callback, e.g. "code=…&state=…".
pub fn parse_callback(request: &str) -> Option<String> {
    let line = request.lines().next()?;
    let path = line.split_whitespace().nth(1)?;
    let (p, q) = path.split_once('?')?;
    (p == "/callback").then(|| q.to_string())
}

#[tauri::command]
pub async fn oauth_wait(port: u16, timeout_secs: Option<u64>) -> BevResult<String> {
    let l = listeners().lock().unwrap().remove(&port).ok_or_else(|| BevError::Invalid("no sign-in in progress".into()))?;
    let secs = timeout_secs.unwrap_or(300).min(900);
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    waits().lock().unwrap().insert(port, cancel.clone());
    let done = cancel.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> BevResult<String> {
        use std::io::{Read, Write};
        l.set_nonblocking(true).ok();
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            match l.accept() {
                Ok((mut s, _)) => {
                    s.set_nonblocking(false).ok();
                    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
                    let mut buf = [0u8; 8192];
                    let n = s.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let Some(q) = parse_callback(&req) else {
                        let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                        continue;
                    };
                    let page = "<!doctype html><meta charset=utf-8><title>BEV</title><body style=\"font-family:Segoe UI,sans-serif;background:#05070d;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0\"><p>Signed in. You can close this tab and go back to BEV.</p>";
                    let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len()).as_bytes());
                    return Ok(q);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                        return Err(BevError::Message("sign-in was restarted".into()));
                    }
                    if std::time::Instant::now() > deadline {
                        return Err(BevError::Message("sign-in timed out".into()));
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(e) => return Err(BevError::Os(e.to_string())),
            }
        }
    })
    .await
    .map_err(|e| BevError::Os(e.to_string()))?;
    // Forget our cancel flag unless a newer sign-in has already replaced it.
    let mut w = waits().lock().unwrap();
    if w.get(&port).is_some_and(|f| std::sync::Arc::ptr_eq(f, &done)) {
        w.remove(&port);
    }
    result
}

// ---------------------------------------------------------------------------
// MCP servers that run as local programs (stdio transport, JSON-RPC per line).
// Only servers the user added in settings are started; the AI can't add them.

struct McpProc {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    pending: std::sync::Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>>,
}

fn procs() -> &'static Mutex<HashMap<String, McpProc>> {
    static S: OnceLock<Mutex<HashMap<String, McpProc>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The id of a JSON-RPC response, as a string key ("7" or "\"abc\"").
pub fn response_id(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("result").is_none() && v.get("error").is_none() {
        return None; // a notification or a request from the server
    }
    v.get("id").map(|id| id.to_string())
}

#[tauri::command]
pub fn mcp_spawn(id: String, command: String, args: Vec<String>, env: Option<HashMap<String, String>>) -> BevResult<()> {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    mcp_kill(id.clone()).ok();
    let mut cmd = Command::new(&command);
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(e) = env {
        cmd.envs(e);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let mut child = cmd.spawn().map_err(|e| BevError::Message(format!("couldn't start {command}: {e}")))?;
    let stdin = child.stdin.take().ok_or_else(|| BevError::Os("no stdin".into()))?;
    let stdout = child.stdout.take().ok_or_else(|| BevError::Os("no stdout".into()))?;
    let pending: std::sync::Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>> = Default::default();
    let p2 = pending.clone();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Some(rid) = response_id(&line) {
                if let Some(tx) = p2.lock().unwrap().remove(&rid) {
                    let _ = tx.send(line);
                }
            }
        }
        p2.lock().unwrap().clear(); // waiting requests see the server has gone
    });
    procs().lock().unwrap().insert(id, McpProc { child, stdin, pending });
    Ok(())
}

/// Send one JSON-RPC message; for requests (with an id) wait for the reply.
#[tauri::command]
pub async fn mcp_send(id: String, message: String, timeout_secs: Option<u64>) -> BevResult<Option<String>> {
    use std::io::Write;
    let rid = serde_json::from_str::<serde_json::Value>(&message)
        .map_err(|e| BevError::Invalid(e.to_string()))?
        .get("id")
        .map(|v| v.to_string());
    let rx = {
        let mut map = procs().lock().unwrap();
        let p = map.get_mut(&id).ok_or_else(|| BevError::Message(format!("the {id} server isn't running")))?;
        let rx = rid.as_ref().map(|r| {
            let (tx, rx) = std::sync::mpsc::channel();
            p.pending.lock().unwrap().insert(r.clone(), tx);
            rx
        });
        p.stdin.write_all(format!("{}\n", message.replace('\n', " ")).as_bytes()).map_err(|e| BevError::Message(format!("the {id} server stopped: {e}")))?;
        p.stdin.flush().ok();
        rx
    };
    let Some(rx) = rx else { return Ok(None) };
    let secs = timeout_secs.unwrap_or(60).min(600);
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(secs)))
        .await
        .map_err(|e| BevError::Os(e.to_string()))?
        .map(Some)
        .map_err(|_| BevError::Message(format!("the {id} server didn't answer")))
}

#[tauri::command]
pub fn mcp_kill(id: String) -> BevResult<()> {
    if let Some(mut p) = procs().lock().unwrap().remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert_eq!(origin_of("http://192.168.1.20:8123/api/states").as_deref(), Some("http://192.168.1.20:8123"));
        assert_eq!(origin_of("HTTPS://API.GitHub.com/user").as_deref(), Some("https://api.github.com"));
        assert_eq!(origin_of("file:///c:/x"), None);
        assert_eq!(origin_of("https://user:pw@evil.com/"), None);
        let user: HashSet<String> = ["http://homeassistant.local:8123".to_string()].into();
        assert!(allowed("https://api.github.com/notifications", &user));
        assert!(allowed("http://homeassistant.local:8123/api/", &user));
        assert!(!allowed("http://homeassistant.local:9999/api/", &user));
        assert!(!allowed("https://api.github.com.evil.com/x", &user));
    }

    #[test]
    fn callback_parsing() {
        assert_eq!(parse_callback("GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n").as_deref(), Some("code=abc&state=xyz"));
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n"), None);
        assert_eq!(parse_callback(""), None);
    }

    #[test]
    fn sign_in_can_restart_on_a_fixed_port() {
        // A first attempt left open (browser never opened) must not block the next one.
        let p = oauth_listen(None).unwrap();
        listeners().lock().unwrap().remove(&p);
        let first = oauth_listen(Some(p)).unwrap();
        assert_eq!(oauth_listen(Some(first)).unwrap(), first);
        // A wait in progress is cancelled and its port handed over.
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        waits().lock().unwrap().insert(first, flag.clone());
        assert_eq!(oauth_listen(Some(first)).unwrap(), first);
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
        listeners().lock().unwrap().remove(&first);
    }

    #[test]
    fn rpc_ids() {
        assert_eq!(response_id(r#"{"jsonrpc":"2.0","id":7,"result":{}}"#).as_deref(), Some("7"));
        assert_eq!(response_id(r#"{"jsonrpc":"2.0","id":"a","error":{"code":1}}"#).as_deref(), Some("\"a\""));
        assert_eq!(response_id(r#"{"jsonrpc":"2.0","method":"notifications/progress"}"#), None);
        assert_eq!(response_id("not json"), None);
    }
}

// ---------------------------------------------------------------------------
// Reading public web pages for research. GET only, public addresses only
// (no localhost, LAN or link-local, checked on every redirect hop), capped.

pub fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private() || v.is_loopback() || v.is_link_local() || v.is_broadcast() || v.is_unspecified() || v.is_documentation()
                || o[0] == 0 || (o[0] == 100 && (64..128).contains(&o[1])) // CGNAT
                || o[0] >= 224)
        }
        std::net::IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(v4));
            }
            let s = v.segments();
            !(v.is_loopback() || v.is_unspecified() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xff00) == 0xff00)
        }
    }
}

fn check_public(url: &reqwest::Url) -> BevResult<()> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(BevError::Message("only web pages (http/https) can be read".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(BevError::Message("addresses with passwords aren't allowed".into()));
    }
    let host = url.host_str().ok_or_else(|| BevError::Message("no host in that address".into()))?;
    let port = url.port_or_known_default().unwrap_or(443);
    use std::net::ToSocketAddrs;
    let addrs: Vec<_> = (host, port).to_socket_addrs().map_err(|e| BevError::Message(format!("couldn't find {host}: {e}")))?.collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(BevError::Message("BEV only reads public websites, not addresses on this PC or your network".into()));
    }
    Ok(())
}

#[derive(Serialize)]
pub struct WebPage {
    pub status: u16,
    pub url: String,
    pub content_type: String,
    pub body: String,
}

#[tauri::command]
pub async fn web_fetch(url: String) -> BevResult<WebPage> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) BEV/1 (personal assistant)")
        .build()
        .map_err(|e| BevError::Os(e.to_string()))?;
    let mut current = reqwest::Url::parse(url.trim()).map_err(|_| BevError::Message("that isn't a valid web address".into()))?;
    for _ in 0..6 {
        let u = current.clone();
        tauri::async_runtime::spawn_blocking(move || check_public(&u)).await.map_err(|e| BevError::Os(e.to_string()))??;
        let res = client.get(current.clone()).send().await.map_err(|e| BevError::Message(format!("couldn't load the page: {}", e.without_url())))?;
        if res.status().is_redirection() {
            let loc = res.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| BevError::Message("the page redirected nowhere".into()))?;
            current = current.join(loc).map_err(|_| BevError::Message("bad redirect".into()))?;
            continue;
        }
        let status = res.status().as_u16();
        let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if !(content_type.is_empty() || content_type.contains("text") || content_type.contains("json") || content_type.contains("xml")) {
            return Err(BevError::Message(format!("that link is a file ({content_type}), not a page BEV can read")));
        }
        let bytes = res.bytes().await.map_err(|e| BevError::Os(e.without_url().to_string()))?;
        let body = String::from_utf8_lossy(&bytes[..bytes.len().min(3 * 1024 * 1024)]).into_owned();
        return Ok(WebPage { status, url: current.to_string(), content_type, body });
    }
    Err(BevError::Message("too many redirects".into()))
}

#[cfg(test)]
mod web_tests {
    use super::is_public_ip;
    #[test]
    fn public_ips_only() {
        for p in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(is_public_ip(p.parse().unwrap()), "{p}");
        }
        for p in ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.4.4", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.1"] {
            assert!(!is_public_ip(p.parse().unwrap()), "{p}");
        }
    }
}
