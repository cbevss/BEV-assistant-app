//! WhatsApp messages from Windows' own notification store, so BEV can see new
//! messages while WhatsApp is minimised or closed to the tray. Windows keeps every
//! toast it shows (until it's cleared from the notification centre) in
//! %LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db. BEV copies that
//! database (it's in use by Windows) and reads only WhatsApp's toasts from the copy.
//! Nothing here talks to WhatsApp's servers.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct WaNotification {
    pub id: i64,
    /// Unix seconds.
    pub time: i64,
    /// The chat (a person or a group).
    pub chat: String,
    /// The message as the notification shows it (may start "Name: " in groups).
    pub text: String,
}

/// The texts in a toast's XML (<text>…</text>), unescaped. Pure; tested.
pub fn toast_texts(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<text") {
        let after = &rest[start + 5..];
        // <text> or <text id="1" ...>, not <textbox
        if !(after.starts_with('>') || after.starts_with(' ')) {
            rest = after;
            continue;
        }
        let Some(open_end) = after.find('>') else { break };
        if after[..open_end].ends_with('/') {
            rest = &after[open_end + 1..];
            continue;
        }
        let body = &after[open_end + 1..];
        let Some(close) = body.find("</text>") else { break };
        let t = unescape(body[..close].trim());
        if !t.is_empty() {
            out.push(t);
        }
        rest = &body[close + 7..];
    }
    out
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Is this notification handler WhatsApp? (Store app id or the older desktop app.) Pure; tested.
pub fn is_whatsapp(handler: &str) -> bool {
    let h = handler.to_ascii_lowercase();
    h.contains("whatsapp")
}

/// Windows FILETIME (100ns since 1601) → unix seconds. Pure; tested.
pub fn filetime_to_unix(ft: i64) -> i64 {
    if ft <= 0 {
        return 0;
    }
    ft / 10_000_000 - 11_644_473_600
}

/// Turn one toast into a message, or None for WhatsApp's non-message toasts. Pure; tested.
pub fn to_message(id: i64, time: i64, xml: &str) -> Option<WaNotification> {
    let texts = toast_texts(xml);
    let chat = texts.first()?.clone();
    let text = texts[1..].join("\n");
    if text.is_empty() {
        return None;
    }
    Some(WaNotification { id, time, chat, text: text.chars().take(1000).collect() })
}

#[cfg(windows)]
fn read_store(since_id: i64) -> Result<Vec<WaNotification>, String> {
    use std::path::PathBuf;
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA isn't set".to_string())?;
    let dir = PathBuf::from(local).join("Microsoft").join("Windows").join("Notifications");
    let db = dir.join("wpndatabase.db");
    if !db.exists() {
        return Err("Windows' notification store wasn't found.".into());
    }
    // Copy the database and its write-ahead log: Windows keeps the real one open.
    let tmp = std::env::temp_dir().join("bev-wpn");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let copy = tmp.join("wpn.db");
    std::fs::copy(&db, &copy).map_err(|e| format!("Couldn't copy the notification store: {e}"))?;
    for ext in ["-wal", "-shm"] {
        let src = dir.join(format!("wpndatabase.db{ext}"));
        let dst = tmp.join(format!("wpn.db{ext}"));
        let _ = std::fs::remove_file(&dst);
        if src.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
    let conn = rusqlite::Connection::open(&copy).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT n.Id, n.ArrivalTime, n.Payload, h.PrimaryId
             FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
             WHERE n.Type = 'toast' AND n.Id > ?1 ORDER BY n.Id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([since_id], |r| {
            let payload: Vec<u8> = r.get::<_, Option<Vec<u8>>>(2)?.unwrap_or_default();
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0), payload, r.get::<_, String>(3)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows.flatten() {
        let (id, arrival, payload, handler) = row;
        if !is_whatsapp(&handler) {
            continue;
        }
        let xml = String::from_utf8_lossy(&payload);
        if let Some(m) = to_message(id, filetime_to_unix(arrival), &xml) {
            out.push(m);
        }
    }
    drop(stmt);
    drop(conn);
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(out)
}

#[cfg(not(windows))]
fn read_store(_since_id: i64) -> Result<Vec<WaNotification>, String> {
    Ok(Vec::new())
}

/// WhatsApp notifications newer than `since_id` (0 = all that Windows still has).
#[tauri::command]
pub async fn whatsapp_notifications(since_id: i64) -> Result<Vec<WaNotification>, String> {
    tauri::async_runtime::spawn_blocking(move || read_store(since_id)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOAST: &str = r#"<toast launch="x"><visual><binding template="ToastGeneric"><text hint-maxLines="1">Mum</text><text>Are you coming for tea? &amp; bring milk</text><image src="a.png"/></binding></visual></toast>"#;

    #[test]
    fn reads_texts() {
        assert_eq!(toast_texts(TOAST), vec!["Mum".to_string(), "Are you coming for tea? & bring milk".to_string()]);
    }

    #[test]
    fn makes_message() {
        let m = to_message(7, 100, TOAST).unwrap();
        assert_eq!(m.chat, "Mum");
        assert!(m.text.starts_with("Are you"));
        assert!(to_message(1, 0, "<toast><visual><binding><text>WhatsApp</text></binding></visual></toast>").is_none());
    }

    #[test]
    fn handler_and_time() {
        assert!(is_whatsapp("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"));
        assert!(!is_whatsapp("Microsoft.Windows.Explorer"));
        assert_eq!(filetime_to_unix(116_444_736_000_000_000), 0);
    }
}
