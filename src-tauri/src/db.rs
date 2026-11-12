//! SQLite store for memories and an action audit log. Credentials never live
//! here — those go to the OS keyring (see secrets.rs).

use crate::{error::BevResult, AppState};
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

pub fn open(path: &std::path::Path) -> BevResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            value TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'general',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );
         CREATE TABLE IF NOT EXISTS action_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tool TEXT NOT NULL,
            args TEXT,
            result TEXT,
            ok INTEGER NOT NULL,
            at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
         );",
    )?;
    Ok(conn)
}

#[derive(Serialize)]
pub struct Memory {
    pub id: i64,
    pub key: String,
    pub value: String,
    pub category: String,
    pub updated_at: i64,
}

#[tauri::command]
pub fn memory_list(state: State<AppState>) -> BevResult<Vec<Memory>> {
    let conn = state.db.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT id, key, value, category, updated_at FROM memories ORDER BY updated_at DESC")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Memory {
                id: r.get(0)?,
                key: r.get(1)?,
                value: r.get(2)?,
                category: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn memory_upsert(
    state: State<AppState>,
    key: String,
    value: String,
    category: Option<String>,
) -> BevResult<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO memories (key, value, category) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value=?2, category=?3, updated_at=strftime('%s','now')",
        rusqlite::params![key, value, category.unwrap_or_else(|| "general".into())],
    )?;
    Ok(())
}

#[tauri::command]
pub fn memory_delete(state: State<AppState>, id: i64) -> BevResult<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM memories WHERE id = ?1", [id])?;
    Ok(())
}

#[derive(Serialize)]
pub struct ActionLogRow {
    pub id: i64,
    pub tool: String,
    pub args: Option<String>,
    pub result: Option<String>,
    pub ok: bool,
    pub at: i64,
}

#[tauri::command]
pub fn action_log_list(state: State<AppState>, limit: Option<i64>) -> BevResult<Vec<ActionLogRow>> {
    let conn = state.db.lock().unwrap();
    let mut stmt =
        conn.prepare("SELECT id, tool, args, result, ok, at FROM action_log ORDER BY id DESC LIMIT ?1")?;
    let rows = stmt
        .query_map([limit.unwrap_or(200).clamp(1, 2000)], |r| {
            Ok(ActionLogRow {
                id: r.get(0)?,
                tool: r.get(1)?,
                args: r.get(2)?,
                result: r.get(3)?,
                ok: r.get::<_, i64>(4)? != 0,
                at: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn action_log_clear(state: State<AppState>) -> BevResult<()> {
    let conn = state.db.lock().unwrap();
    conn.execute("DELETE FROM action_log", [])?;
    Ok(())
}

#[tauri::command]
pub fn log_action(
    state: State<AppState>,
    tool: String,
    args: Option<String>,
    result: Option<String>,
    ok: bool,
) -> BevResult<()> {
    let conn = state.db.lock().unwrap();
    conn.execute(
        "INSERT INTO action_log (tool, args, result, ok) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![tool, args, result, ok as i64],
    )?;
    Ok(())
}
