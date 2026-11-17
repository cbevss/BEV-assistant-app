//! Task journal: every request BEV acts on is recorded with its steps and
//! outcome. If BEV stops mid-task (crash, PC shut down), the run is still
//! "running" at next start; it's marked interrupted and BEV is told once, so
//! it knows what happened instead of silently forgetting.

use crate::{error::BevResult, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            steps TEXT NOT NULL DEFAULT '[]',
            result TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            acknowledged INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS task_runs_status ON task_runs (status);",
    )
}

/// At startup: anything still running was cut off. Returns how many.
pub fn mark_interrupted(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE task_runs SET status = 'interrupted', ended_at = ?1, acknowledged = 0 WHERE status = 'running'",
        [now],
    )
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Step {
    pub tool: String,
    pub ok: bool,
    pub summary: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct TaskRun {
    pub id: i64,
    pub request: String,
    pub status: String,
    pub steps: Vec<Step>,
    pub result: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

pub fn start(conn: &Connection, request: &str, now: i64) -> rusqlite::Result<i64> {
    conn.execute("INSERT INTO task_runs (request, started_at) VALUES (?1, ?2)", params![clip(request, 500), now])?;
    Ok(conn.last_insert_rowid())
}

pub fn step(conn: &Connection, id: i64, s: &Step) -> rusqlite::Result<()> {
    let cur: Option<String> = conn.query_row("SELECT steps FROM task_runs WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    let Some(cur) = cur else { return Ok(()) };
    let mut steps: Vec<Step> = serde_json::from_str(&cur).unwrap_or_default();
    // Bounded: a runaway loop shouldn't bloat the row.
    if steps.len() < 50 {
        steps.push(Step { tool: s.tool.clone(), ok: s.ok, summary: clip(&s.summary, 300) });
    }
    conn.execute("UPDATE task_runs SET steps = ?1 WHERE id = ?2", params![serde_json::to_string(&steps).unwrap_or_default(), id])?;
    Ok(())
}

pub fn finish(conn: &Connection, id: i64, status: &str, result: Option<&str>, now: i64) -> rusqlite::Result<()> {
    let status = match status {
        "done" | "failed" | "cancelled" => status,
        _ => "failed",
    };
    conn.execute(
        "UPDATE task_runs SET status = ?1, result = ?2, ended_at = ?3 WHERE id = ?4 AND status = 'running'",
        params![status, result.map(|r| clip(r, 1000)), now, id],
    )?;
    // Keep the journal from growing forever.
    conn.execute("DELETE FROM task_runs WHERE id NOT IN (SELECT id FROM task_runs ORDER BY id DESC LIMIT 500)", [])?;
    Ok(())
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<TaskRun> {
    let steps: String = r.get(3)?;
    Ok(TaskRun {
        id: r.get(0)?,
        request: r.get(1)?,
        status: r.get(2)?,
        steps: serde_json::from_str(&steps).unwrap_or_default(),
        result: r.get(4)?,
        started_at: r.get(5)?,
        ended_at: r.get(6)?,
    })
}

const COLS: &str = "id, request, status, steps, result, started_at, ended_at";

pub fn recent(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<TaskRun>> {
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM task_runs ORDER BY id DESC LIMIT ?1"))?;
    let rows = st.query_map([limit.clamp(1, 200)], row)?.collect();
    rows
}

/// Interrupted runs BEV hasn't told the user about yet; marks them told.
pub fn take_unacknowledged(conn: &Connection) -> rusqlite::Result<Vec<TaskRun>> {
    let mut st = conn.prepare(&format!("SELECT {COLS} FROM task_runs WHERE status = 'interrupted' AND acknowledged = 0 ORDER BY id"))?;
    let rows: Vec<TaskRun> = st.query_map([], row)?.collect::<Result<_, _>>()?;
    conn.execute("UPDATE task_runs SET acknowledged = 1 WHERE status = 'interrupted' AND acknowledged = 0", [])?;
    Ok(rows)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
pub fn journal_start(state: State<AppState>, request: String) -> BevResult<i64> {
    Ok(start(&state.db.lock().unwrap(), &request, now_ms())?)
}

#[tauri::command]
pub fn journal_step(state: State<AppState>, id: i64, tool: String, ok: bool, summary: String) -> BevResult<()> {
    Ok(step(&state.db.lock().unwrap(), id, &Step { tool, ok, summary })?)
}

#[tauri::command]
pub fn journal_finish(state: State<AppState>, id: i64, status: String, result: Option<String>) -> BevResult<()> {
    Ok(finish(&state.db.lock().unwrap(), id, &status, result.as_deref(), now_ms())?)
}

#[tauri::command]
pub fn journal_recent(state: State<AppState>, limit: Option<i64>) -> BevResult<Vec<TaskRun>> {
    Ok(recent(&state.db.lock().unwrap(), limit.unwrap_or(30))?)
}

#[tauri::command]
pub fn journal_take_interrupted(state: State<AppState>) -> BevResult<Vec<TaskRun>> {
    Ok(take_unacknowledged(&state.db.lock().unwrap())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init(&c).unwrap();
        c
    }

    #[test]
    fn records_a_completed_task() {
        let c = db();
        let id = start(&c, "open antimicro", 1).unwrap();
        step(&c, id, &Step { tool: "launch_app".into(), ok: true, summary: "Opened Antimicro".into() }).unwrap();
        finish(&c, id, "done", Some("It's open."), 2).unwrap();
        let r = &recent(&c, 5).unwrap()[0];
        assert_eq!(r.status, "done");
        assert_eq!(r.steps, vec![Step { tool: "launch_app".into(), ok: true, summary: "Opened Antimicro".into() }]);
        assert_eq!(r.ended_at, Some(2));
    }

    #[test]
    fn a_crash_mid_task_is_reported_once() {
        let c = db();
        let id = start(&c, "organise my downloads folder", 1).unwrap();
        step(&c, id, &Step { tool: "list_files".into(), ok: true, summary: "142 files".into() }).unwrap();
        // BEV stops here. Next launch:
        assert_eq!(mark_interrupted(&c, 10).unwrap(), 1);
        let told = take_unacknowledged(&c).unwrap();
        assert_eq!(told.len(), 1);
        assert_eq!(told[0].request, "organise my downloads folder");
        assert_eq!(told[0].steps.len(), 1);
        assert!(take_unacknowledged(&c).unwrap().is_empty(), "only told once");
        // A late finish from the old run can't overwrite "interrupted".
        finish(&c, id, "done", None, 11).unwrap();
        assert_eq!(recent(&c, 1).unwrap()[0].status, "interrupted");
    }

    #[test]
    fn bounds_and_sanitises() {
        let c = db();
        let id = start(&c, &"x".repeat(2000), 1).unwrap();
        for _ in 0..80 {
            step(&c, id, &Step { tool: "t".into(), ok: true, summary: "y".repeat(1000) }).unwrap();
        }
        finish(&c, id, "weird-status", None, 2).unwrap();
        let r = &recent(&c, 1).unwrap()[0];
        assert_eq!(r.steps.len(), 50);
        assert!(r.request.chars().count() <= 501);
        assert_eq!(r.status, "failed");
    }
}
