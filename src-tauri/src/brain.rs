//! BEV's long-term memory beyond key/value facts: searchable conversation
//! history and a notes vault with sources. Everything is in the local SQLite
//! database; full-text search uses SQLite FTS5. Embeddings for semantic search
//! are computed in the app (on this PC) and stored here as little-endian f32.
//!
//! The SQL lives in plain functions over a Connection so it's unit-tested.

use crate::{error::BevResult, AppState};
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS conv_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session TEXT NOT NULL,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE INDEX IF NOT EXISTS conv_messages_at ON conv_messages(at);
         CREATE INDEX IF NOT EXISTS conv_messages_session ON conv_messages(session);
         CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(text, content='conv_messages', content_rowid='id', tokenize='porter unicode61');
         CREATE TRIGGER IF NOT EXISTS conv_ai AFTER INSERT ON conv_messages BEGIN
            INSERT INTO conv_fts(rowid, text) VALUES (new.id, new.text);
         END;
         CREATE TRIGGER IF NOT EXISTS conv_ad AFTER DELETE ON conv_messages BEGIN
            INSERT INTO conv_fts(conv_fts, rowid, text) VALUES ('delete', old.id, old.text);
         END;

         CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '',
            embedding BLOB,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, tags, content='notes', content_rowid='id', tokenize='porter unicode61');
         CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
         END;
         CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
         END;
         CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, body, tags ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
            INSERT INTO notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
         END;",
    )?;
    // Memories gain an embedding and where they came from.
    let cols: Vec<String> = conn.prepare("PRAGMA table_info(memories)")?.query_map([], |r| r.get::<_, String>(1))?.collect::<Result<_, _>>()?;
    if !cols.iter().any(|c| c == "embedding") {
        conn.execute_batch("ALTER TABLE memories ADD COLUMN embedding BLOB;")?;
    }
    Ok(())
}

/// User words → a safe FTS5 query: each word quoted (no operators can be
/// injected), last word as a prefix. `any` joins with OR instead of AND.
pub fn fts_query(text: &str, any: bool) -> Option<String> {
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .map(|w| w.trim_matches('\'').to_lowercase())
        .filter(|w| w.chars().count() > 1)
        .take(12)
        .collect();
    if words.is_empty() {
        return None;
    }
    let n = words.len();
    let parts: Vec<String> = words.into_iter().enumerate().map(|(i, w)| if i == n - 1 { format!("\"{w}\"*") } else { format!("\"{w}\"") }).collect();
    Some(parts.join(if any { " OR " } else { " " }))
}

// ---------------------------------------------------------------------------
// Conversations

#[derive(Serialize, Debug)]
pub struct ConvHit {
    pub id: i64,
    pub session: String,
    pub role: String,
    pub snippet: String,
    pub at: i64,
}

#[derive(Serialize, Debug)]
pub struct ConvMessage {
    pub role: String,
    pub text: String,
    pub at: i64,
}

#[derive(Serialize, Debug)]
pub struct ConvSession {
    pub session: String,
    pub started: i64,
    pub first: String,
    pub count: i64,
}

pub fn conv_add_sql(c: &Connection, session: &str, role: &str, text: &str) -> rusqlite::Result<i64> {
    c.execute("INSERT INTO conv_messages (session, role, text) VALUES (?1, ?2, ?3)", params![session, role, text])?;
    Ok(c.last_insert_rowid())
}

pub fn conv_search_sql(c: &Connection, query: &str, limit: i64) -> rusqlite::Result<Vec<ConvHit>> {
    let run = |q: &str| -> rusqlite::Result<Vec<ConvHit>> {
        let mut st = c.prepare(
            "SELECT m.id, m.session, m.role, snippet(conv_fts, 0, '[', ']', '…', 14), m.at
             FROM conv_fts JOIN conv_messages m ON m.id = conv_fts.rowid
             WHERE conv_fts MATCH ?1 ORDER BY bm25(conv_fts), m.at DESC LIMIT ?2",
        )?;
        let rows = st.query_map(params![q, limit], |r| Ok(ConvHit { id: r.get(0)?, session: r.get(1)?, role: r.get(2)?, snippet: r.get(3)?, at: r.get(4)? }))?;
        rows.collect()
    };
    let Some(all) = fts_query(query, false) else { return Ok(vec![]) };
    let hits = run(&all)?;
    if !hits.is_empty() {
        return Ok(hits);
    }
    match fts_query(query, true) {
        Some(any) => run(&any),
        None => Ok(vec![]),
    }
}

pub fn conv_session_sql(c: &Connection, session: &str, limit: i64) -> rusqlite::Result<Vec<ConvMessage>> {
    let mut st = c.prepare("SELECT role, text, at FROM conv_messages WHERE session = ?1 ORDER BY id LIMIT ?2")?;
    let rows = st.query_map(params![session, limit], |r| Ok(ConvMessage { role: r.get(0)?, text: r.get(1)?, at: r.get(2)? }))?;
    rows.collect()
}

pub fn conv_sessions_sql(c: &Connection, limit: i64) -> rusqlite::Result<Vec<ConvSession>> {
    let mut st = c.prepare(
        "SELECT session, MIN(at), (SELECT text FROM conv_messages f WHERE f.session = m.session ORDER BY id LIMIT 1), COUNT(*)
         FROM conv_messages m GROUP BY session ORDER BY MAX(at) DESC LIMIT ?1",
    )?;
    let rows = st.query_map([limit], |r| Ok(ConvSession { session: r.get(0)?, started: r.get(1)?, first: r.get(2)?, count: r.get(3)? }))?;
    rows.collect()
}

pub fn conv_prune_sql(c: &Connection, keep_days: i64) -> rusqlite::Result<usize> {
    c.execute("DELETE FROM conv_messages WHERE at < strftime('%s','now') - ?1 * 86400", [keep_days])
}

#[tauri::command]
pub fn conv_add(state: State<AppState>, session: String, role: String, text: String) -> BevResult<i64> {
    let text: String = text.chars().take(8000).collect();
    Ok(conv_add_sql(&state.db.lock().unwrap(), &session, &role, &text)?)
}

#[tauri::command]
pub fn conv_search(state: State<AppState>, query: String, limit: Option<i64>) -> BevResult<Vec<ConvHit>> {
    Ok(conv_search_sql(&state.db.lock().unwrap(), &query, limit.unwrap_or(8).clamp(1, 50))?)
}

#[tauri::command]
pub fn conv_session(state: State<AppState>, session: String) -> BevResult<Vec<ConvMessage>> {
    Ok(conv_session_sql(&state.db.lock().unwrap(), &session, 200)?)
}

#[tauri::command]
pub fn conv_sessions(state: State<AppState>, limit: Option<i64>) -> BevResult<Vec<ConvSession>> {
    Ok(conv_sessions_sql(&state.db.lock().unwrap(), limit.unwrap_or(30).clamp(1, 500))?)
}

#[tauri::command]
pub fn conv_prune(state: State<AppState>, keep_days: i64) -> BevResult<usize> {
    Ok(conv_prune_sql(&state.db.lock().unwrap(), keep_days.max(1))?)
}

#[tauri::command]
pub fn conv_clear(state: State<AppState>) -> BevResult<()> {
    let c = state.db.lock().unwrap();
    c.execute_batch("DELETE FROM conv_messages; INSERT INTO conv_fts(conv_fts) VALUES('rebuild');")?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Notes vault

#[derive(Serialize, Debug)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub source: String,
    pub tags: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_embedding: bool,
}

#[derive(Serialize, Debug)]
pub struct NoteHit {
    pub id: i64,
    pub title: String,
    pub snippet: String,
    pub source: String,
    pub updated_at: i64,
}

fn note_row(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        body: r.get(2)?,
        source: r.get(3)?,
        tags: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        has_embedding: r.get::<_, Option<Vec<u8>>>(7)?.is_some(),
    })
}
const NOTE_COLS: &str = "id, title, body, source, tags, created_at, updated_at, embedding";

pub fn note_save_sql(c: &Connection, id: Option<i64>, title: &str, body: &str, source: &str, tags: &str) -> rusqlite::Result<i64> {
    match id {
        Some(id) => {
            // Text changed: the old embedding no longer matches.
            c.execute(
                "UPDATE notes SET title=?2, body=?3, source=?4, tags=?5, embedding=NULL, updated_at=strftime('%s','now') WHERE id=?1",
                params![id, title, body, source, tags],
            )?;
            Ok(id)
        }
        None => {
            c.execute("INSERT INTO notes (title, body, source, tags) VALUES (?1, ?2, ?3, ?4)", params![title, body, source, tags])?;
            Ok(c.last_insert_rowid())
        }
    }
}

pub fn notes_search_sql(c: &Connection, query: &str, limit: i64) -> rusqlite::Result<Vec<NoteHit>> {
    let run = |q: &str| -> rusqlite::Result<Vec<NoteHit>> {
        let mut st = c.prepare(
            "SELECT n.id, n.title, snippet(notes_fts, 1, '[', ']', '…', 24), n.source, n.updated_at
             FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
             WHERE notes_fts MATCH ?1 ORDER BY bm25(notes_fts, 4.0, 1.0, 2.0) LIMIT ?2",
        )?;
        let rows = st.query_map(params![q, limit], |r| Ok(NoteHit { id: r.get(0)?, title: r.get(1)?, snippet: r.get(2)?, source: r.get(3)?, updated_at: r.get(4)? }))?;
        rows.collect()
    };
    let Some(all) = fts_query(query, false) else { return Ok(vec![]) };
    let hits = run(&all)?;
    if !hits.is_empty() {
        return Ok(hits);
    }
    match fts_query(query, true) {
        Some(any) => run(&any),
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub fn notes_list(state: State<AppState>) -> BevResult<Vec<Note>> {
    let c = state.db.lock().unwrap();
    let mut st = c.prepare(&format!("SELECT {NOTE_COLS} FROM notes ORDER BY updated_at DESC"))?;
    let rows = st.query_map([], note_row)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn note_get(state: State<AppState>, id: i64) -> BevResult<Option<Note>> {
    let c = state.db.lock().unwrap();
    Ok(c.query_row(&format!("SELECT {NOTE_COLS} FROM notes WHERE id=?1"), [id], note_row).optional()?)
}

#[tauri::command]
pub fn note_save(state: State<AppState>, id: Option<i64>, title: String, body: String, source: Option<String>, tags: Option<String>) -> BevResult<i64> {
    let body: String = body.chars().take(50_000).collect();
    let title: String = title.chars().take(200).collect();
    Ok(note_save_sql(&state.db.lock().unwrap(), id, &title, &body, source.as_deref().unwrap_or(""), tags.as_deref().unwrap_or(""))?)
}

#[tauri::command]
pub fn note_delete(state: State<AppState>, id: i64) -> BevResult<()> {
    state.db.lock().unwrap().execute("DELETE FROM notes WHERE id=?1", [id])?;
    Ok(())
}

#[tauri::command]
pub fn notes_search(state: State<AppState>, query: String, limit: Option<i64>) -> BevResult<Vec<NoteHit>> {
    Ok(notes_search_sql(&state.db.lock().unwrap(), &query, limit.unwrap_or(6).clamp(1, 50))?)
}

// ---------------------------------------------------------------------------
// Embeddings (computed in the app; stored here)

#[derive(Serialize, Debug)]
pub struct Embedding {
    pub id: i64,
    /// Base64 little-endian f32.
    pub vec: String,
}

fn table(kind: &str) -> BevResult<&'static str> {
    match kind {
        "memory" => Ok("memories"),
        "note" => Ok("notes"),
        _ => Err(crate::error::BevError::Invalid(format!("unknown kind {kind}"))),
    }
}

pub fn set_embedding_sql(c: &Connection, table: &str, id: i64, bytes: &[u8]) -> rusqlite::Result<usize> {
    c.execute(&format!("UPDATE {table} SET embedding=?2 WHERE id=?1"), params![id, bytes])
}

pub fn embeddings_sql(c: &Connection, table: &str) -> rusqlite::Result<Vec<(i64, Vec<u8>)>> {
    let mut st = c.prepare(&format!("SELECT id, embedding FROM {table} WHERE embedding IS NOT NULL"))?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

#[tauri::command]
pub fn set_embedding(state: State<AppState>, kind: String, id: i64, vec: String) -> BevResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(vec).map_err(|e| crate::error::BevError::Invalid(e.to_string()))?;
    if bytes.len() % 4 != 0 || bytes.len() > 16_384 {
        return Err(crate::error::BevError::Invalid("bad embedding".into()));
    }
    set_embedding_sql(&state.db.lock().unwrap(), table(&kind)?, id, &bytes)?;
    Ok(())
}

#[tauri::command]
pub fn embeddings_list(state: State<AppState>, kind: String) -> BevResult<Vec<Embedding>> {
    let rows = embeddings_sql(&state.db.lock().unwrap(), table(&kind)?)?;
    Ok(rows.into_iter().map(|(id, b)| Embedding { id, vec: base64::engine::general_purpose::STANDARD.encode(b) }).collect())
}

/// When text changes, its embedding is stale. (memory_upsert does this in SQL.)
#[allow(dead_code)]
pub fn clear_memory_embedding_sql(c: &Connection, key: &str) -> rusqlite::Result<usize> {
    c.execute("UPDATE memories SET embedding=NULL WHERE key=?1", [key])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
             category TEXT NOT NULL DEFAULT 'general', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        init(&c).unwrap();
        init(&c).unwrap(); // idempotent
        c
    }

    #[test]
    fn fts_query_is_safe() {
        assert_eq!(fts_query("router password?", false).as_deref(), Some("\"router\" \"password\"*"));
        assert_eq!(fts_query("a", false), None);
        assert_eq!(fts_query("NEAR(x y) OR \"z", true).as_deref(), Some("\"near\" OR \"or\"*"));
        assert_eq!(fts_query("don't stop", false).as_deref(), Some("\"don't\" \"stop\"*"));
    }

    #[test]
    fn conversations_search_and_prune() {
        let c = db();
        conv_add_sql(&c, "s1", "user", "What's the wifi password for the router at Mum's?").unwrap();
        conv_add_sql(&c, "s1", "assistant", "I don't have that stored.").unwrap();
        conv_add_sql(&c, "s2", "user", "Remind me to renew the car insurance on Friday").unwrap();
        let hits = conv_search_sql(&c, "routers", 5).unwrap(); // porter stemming
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session, "s1");
        assert!(hits[0].snippet.contains("[router]"));
        // AND finds nothing → falls back to OR
        assert_eq!(conv_search_sql(&c, "insurance banana", 5).unwrap().len(), 1);
        assert!(conv_search_sql(&c, "!!", 5).unwrap().is_empty());
        assert_eq!(conv_session_sql(&c, "s1", 50).unwrap().len(), 2);
        let sessions = conv_sessions_sql(&c, 10).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions.iter().find(|s| s.session == "s1").unwrap().count, 2);
        c.execute("UPDATE conv_messages SET at = at - 100*86400 WHERE session='s1'", []).unwrap();
        assert_eq!(conv_prune_sql(&c, 90).unwrap(), 2);
        assert!(conv_search_sql(&c, "router", 5).unwrap().is_empty()); // index follows deletes
    }

    #[test]
    fn notes_crud_search_and_embeddings() {
        let c = db();
        let id = note_save_sql(&c, None, "Router setup", "Admin page is 192.168.1.1, firmware updated in March.", "conversation", "home,network").unwrap();
        note_save_sql(&c, None, "Gym plan", "Push pull legs, Mon Wed Fri.", "", "").unwrap();
        let hits = notes_search_sql(&c, "firmware", 5).unwrap();
        assert_eq!(hits[0].id, id);
        assert!(hits[0].snippet.contains("[firmware]"));
        assert_eq!(notes_search_sql(&c, "network", 5).unwrap()[0].id, id); // tags are searched
        set_embedding_sql(&c, "notes", id, &[0, 0, 128, 63]).unwrap();
        assert_eq!(embeddings_sql(&c, "notes").unwrap().len(), 1);
        // Editing updates the index and drops the stale embedding.
        note_save_sql(&c, Some(id), "Router setup", "Admin page moved to 10.0.0.1.", "conversation", "").unwrap();
        assert!(notes_search_sql(&c, "firmware", 5).unwrap().is_empty());
        assert_eq!(notes_search_sql(&c, "admin", 5).unwrap()[0].id, id);
        assert!(embeddings_sql(&c, "notes").unwrap().is_empty());
        c.execute("DELETE FROM notes WHERE id=?1", [id]).unwrap();
        assert!(notes_search_sql(&c, "admin", 5).unwrap().is_empty());
    }

    #[test]
    fn memory_embeddings() {
        let c = db();
        c.execute("INSERT INTO memories (key, value) VALUES ('browser', 'Chrome')", []).unwrap();
        set_embedding_sql(&c, "memories", 1, &[1, 2, 3, 4]).unwrap();
        assert_eq!(embeddings_sql(&c, "memories").unwrap()[0].1, vec![1, 2, 3, 4]);
        clear_memory_embedding_sql(&c, "browser").unwrap();
        assert!(embeddings_sql(&c, "memories").unwrap().is_empty());
    }
}
