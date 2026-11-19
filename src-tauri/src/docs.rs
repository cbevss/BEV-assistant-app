//! "Ask about your documents": a local, searchable index of the text in the
//! documents the user chose (PDF, Word, PowerPoint, Excel, OpenDocument and
//! plain text). Everything stays in BEV's database on this PC; only the
//! passages the AI asks for are sent to it, as part of answering.
//!
//! Extraction runs without holding the database lock, one file at a time, so
//! BEV stays responsive while a big folder is indexed. A file that can't be
//! read (encrypted, broken, too big) is skipped and counted, never fatal.

use crate::error::{BevError, BevResult};
use crate::filemgr::Guard;
use crate::files::expand;
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;
use tauri::Manager;

const MAX_FILE_BYTES: u64 = 60 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const CHUNK_CHARS: usize = 1200;
const MAX_TEXT_CHARS: usize = 2_000_000;
const READ_LIMIT: usize = 24_000;

pub const SUPPORTED: &[&str] = &["pdf", "docx", "pptx", "xlsx", "odt", "odp", "ods", "txt", "md", "csv", "rtf", "log", "json", "html", "htm"];

pub fn init(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS doc_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified INTEGER NOT NULL,
            pages INTEGER NOT NULL DEFAULT 0,
            error TEXT
         );
         CREATE TABLE IF NOT EXISTS doc_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id INTEGER NOT NULL,
            page INTEGER NOT NULL,
            text TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS doc_chunks_file ON doc_chunks(file_id);
         CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(text, content='doc_chunks', content_rowid='id', tokenize='porter unicode61');
         CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
            INSERT INTO doc_fts(rowid, text) VALUES (new.id, new.text);
         END;
         CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
            INSERT INTO doc_fts(doc_fts, rowid, text) VALUES ('delete', old.id, old.text);
         END;",
    )
}

// ---------------------------------------------------------------------------
// Getting text out of files

/// Text per page (one "page" for formats without pages).
pub fn extract(path: &Path) -> Result<Vec<String>, String> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let pages = match ext.as_str() {
        "pdf" => {
            let p = path.to_path_buf();
            // pdf-extract can panic on unusual files; one bad PDF mustn't take BEV down.
            match std::panic::catch_unwind(move || pdf_extract::extract_text_by_pages(&p)) {
                Ok(Ok(pages)) => pages,
                Ok(Err(e)) => return Err(format!("couldn't read this PDF ({e})")),
                Err(_) => return Err("couldn't read this PDF".into()),
            }
        }
        "docx" => vec![xml_text(&zip_entry(path, "word/document.xml")?, &["w:p", "w:br", "w:tab"])],
        "odt" | "odp" | "ods" => vec![xml_text(&zip_entry(path, "content.xml")?, &["text:p", "text:h", "table:table-row"])],
        "pptx" => zip_entries(path, "ppt/slides/slide", ".xml")?.iter().map(|x| xml_text(x, &["a:p"])).collect(),
        "xlsx" => vec![xlsx_text(path)?],
        "html" | "htm" => vec![xml_text(&read_text(path)?, &["p", "br", "div", "li", "tr", "h1", "h2", "h3"])],
        "rtf" => vec![rtf_text(&read_text(path)?)],
        "txt" | "md" | "csv" | "log" | "json" => vec![read_text(path)?],
        _ => return Err("BEV can't read this kind of file".into()),
    };
    let mut total = 0;
    Ok(pages
        .into_iter()
        .map(|p| {
            let t = tidy(&p);
            total += t.len();
            if total > MAX_TEXT_CHARS { String::new() } else { t }
        })
        .collect())
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("couldn't open it ({e})"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn zip_entry(path: &Path, name: &str) -> Result<String, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("couldn't open it ({e})"))?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| "this file looks damaged".to_string())?;
    let mut e = z.by_name(name).map_err(|_| "this file looks damaged".to_string())?;
    let mut s = String::new();
    std::io::Read::read_to_string(&mut e, &mut s).map_err(|_| "this file looks damaged".to_string())?;
    Ok(s)
}

/// Entries named `{prefix}N{suffix}`, in N order (slide1, slide2, … slide10).
fn zip_entries(path: &Path, prefix: &str, suffix: &str) -> Result<Vec<String>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("couldn't open it ({e})"))?;
    let mut z = zip::ZipArchive::new(f).map_err(|_| "this file looks damaged".to_string())?;
    let mut names: Vec<(u32, String)> = z
        .file_names()
        .filter_map(|n| n.strip_prefix(prefix)?.strip_suffix(suffix)?.parse::<u32>().ok().map(|i| (i, n.to_string())))
        .collect();
    names.sort();
    let mut out = Vec::new();
    for (_, n) in names {
        let mut e = z.by_name(&n).map_err(|_| "this file looks damaged".to_string())?;
        let mut s = String::new();
        std::io::Read::read_to_string(&mut e, &mut s).map_err(|_| "this file looks damaged".to_string())?;
        out.push(s);
    }
    Ok(out)
}

fn xlsx_text(path: &Path) -> Result<String, String> {
    // Shared strings hold almost all the words in a workbook; good enough to find it and quote it.
    let shared = zip_entry(path, "xl/sharedStrings.xml").unwrap_or_default();
    Ok(xml_text(&shared, &["si"]))
}

/// Strip XML/HTML tags; the listed elements become line breaks. Decodes the
/// common entities. Skips <script>/<style> content.
pub fn xml_text(xml: &str, breaks: &[&str]) -> String {
    let mut out = String::with_capacity(xml.len() / 3);
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        let Some(gt) = rest[lt..].find('>') else { break };
        let tag = &rest[lt + 1..lt + gt];
        let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_lowercase();
        rest = &rest[lt + gt + 1..];
        if !tag.starts_with('/') && (name == "script" || name == "style") {
            let close = format!("</{name}");
            match rest.to_lowercase().find(&close) {
                Some(i) => rest = &rest[i..],
                None => break,
            }
            continue;
        }
        if !tag.starts_with('/') && breaks.iter().any(|b| b.eq_ignore_ascii_case(&name)) {
            out.push(if name.ends_with("tab") { '\t' } else { '\n' });
        }
    }
    out.push_str(rest);
    decode_entities(&out)
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        match after.find(';').filter(|&i| i <= 8) {
            Some(semi) => {
                let ent = &after[..semi];
                let ch = match ent {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ if ent.starts_with("#x") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
                    _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                    _ => None,
                };
                match ch {
                    Some(c) => {
                        out.push(c);
                        rest = &after[semi + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = after;
                    }
                }
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Rough RTF to text: drop control words and groups like fonts/colours.
pub fn rtf_text(rtf: &str) -> String {
    let mut out = String::new();
    let mut chars = rtf.chars().peekable();
    let mut skip_depth: Option<usize> = None;
    let mut depth = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '{' => depth += 1,
            '}' => {
                if skip_depth == Some(depth) {
                    skip_depth = None;
                }
                depth = depth.saturating_sub(1);
            }
            '\\' => {
                let mut word = String::new();
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_alphabetic() {
                        word.push(n);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if word.is_empty() {
                    if let Some(n) = chars.next() {
                        if n == '\'' {
                            let hex: String = chars.by_ref().take(2).collect();
                            if skip_depth.is_none() {
                                if let Ok(b) = u8::from_str_radix(&hex, 16) {
                                    out.push(b as char);
                                }
                            }
                        } else if skip_depth.is_none() && n != '*' {
                            out.push(n);
                        } else if n == '*' {
                            skip_depth.get_or_insert(depth);
                        }
                    }
                    continue;
                }
                while let Some(&n) = chars.peek() {
                    if n.is_ascii_digit() || n == '-' {
                        chars.next();
                    } else {
                        break;
                    }
                }
                if chars.peek() == Some(&' ') {
                    chars.next();
                }
                if matches!(word.as_str(), "fonttbl" | "colortbl" | "stylesheet" | "info" | "pict" | "header" | "footer") {
                    skip_depth.get_or_insert(depth);
                } else if skip_depth.is_none() && matches!(word.as_str(), "par" | "line" | "row") {
                    out.push('\n');
                } else if skip_depth.is_none() && word == "tab" {
                    out.push('\t');
                }
            }
            '\r' | '\n' => {}
            _ if skip_depth.is_none() => out.push(c),
            _ => {}
        }
    }
    out
}

/// Collapse runs of spaces and blank lines.
fn tidy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.lines() {
        let l = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if l.is_empty() {
            blank += 1;
            if blank == 1 && !out.is_empty() {
                out.push('\n');
            }
            continue;
        }
        blank = 0;
        out.push_str(&l);
        out.push('\n');
    }
    out.trim().to_string()
}

/// Split a page into passages of about CHUNK_CHARS, on paragraph or sentence
/// boundaries where possible.
pub fn chunks(page: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for para in page.split('\n').filter(|p| !p.trim().is_empty()) {
        if cur.len() + para.len() + 1 > CHUNK_CHARS && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        if para.len() > CHUNK_CHARS {
            // A wall of text: cut at sentence ends, else at a char boundary.
            let mut rest = para;
            while rest.len() > CHUNK_CHARS {
                let mut cut = CHUNK_CHARS;
                while !rest.is_char_boundary(cut) {
                    cut -= 1;
                }
                let at = rest[..cut].rfind(". ").map(|i| i + 1).filter(|&i| i > CHUNK_CHARS / 2).unwrap_or(cut);
                out.push(rest[..at].trim().to_string());
                rest = &rest[at..];
            }
            cur.push_str(rest.trim());
        } else {
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(para);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

// ---------------------------------------------------------------------------
// The index (plain SQL, unit-tested)

#[derive(Debug, Serialize, Clone)]
pub struct DocHit {
    pub path: String,
    pub name: String,
    pub page: i64,
    pub snippet: String,
}

pub fn known_sql(c: &Connection, path: &str) -> rusqlite::Result<Option<(i64, i64, i64)>> {
    c.query_row("SELECT id, size, modified FROM doc_files WHERE path = ?1", [path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()
}

pub fn remove_sql(c: &Connection, id: i64) -> rusqlite::Result<()> {
    c.execute("DELETE FROM doc_chunks WHERE file_id = ?1", [id])?;
    c.execute("DELETE FROM doc_files WHERE id = ?1", [id])?;
    Ok(())
}

/// Replace a file's passages (or record why it couldn't be read).
pub fn store_sql(c: &mut Connection, path: &str, name: &str, size: i64, modified: i64, pages: Result<&[String], &str>) -> rusqlite::Result<()> {
    let tx = c.transaction()?;
    if let Some((id, _, _)) = known_sql(&tx, path)? {
        remove_sql(&tx, id)?;
    }
    let (count, err) = match &pages {
        Ok(p) => (p.len() as i64, None),
        Err(e) => (0, Some(e.to_string())),
    };
    tx.execute("INSERT INTO doc_files (path, name, size, modified, pages, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![path, name, size, modified, count, err])?;
    let id = tx.last_insert_rowid();
    if let Ok(pages) = pages {
        let mut st = tx.prepare("INSERT INTO doc_chunks (file_id, page, text) VALUES (?1, ?2, ?3)")?;
        for (i, page) in pages.iter().enumerate() {
            for ch in chunks(page) {
                st.execute(params![id, i as i64 + 1, ch])?;
            }
        }
    }
    tx.commit()
}

pub fn search_sql(c: &Connection, query: &str, limit: i64) -> rusqlite::Result<Vec<DocHit>> {
    let run = |q: &str| -> rusqlite::Result<Vec<DocHit>> {
        let mut st = c.prepare(
            "SELECT f.path, f.name, k.page, snippet(doc_fts, 0, '[', ']', '…', 40)
             FROM doc_fts JOIN doc_chunks k ON k.id = doc_fts.rowid JOIN doc_files f ON f.id = k.file_id
             WHERE doc_fts MATCH ?1 ORDER BY bm25(doc_fts) LIMIT ?2",
        )?;
        let rows = st.query_map(params![q, limit], |r| Ok(DocHit { path: r.get(0)?, name: r.get(1)?, page: r.get(2)?, snippet: r.get(3)? }))?;
        rows.collect()
    };
    let Some(all) = crate::brain::fts_query(query, false) else { return Ok(vec![]) };
    let hits = run(&all)?;
    if !hits.is_empty() {
        return Ok(hits);
    }
    match crate::brain::fts_query(query, true) {
        Some(any) => run(&any),
        None => Ok(vec![]),
    }
}

/// Files whose names match, for "what's in my lease" style questions.
pub fn by_name_sql(c: &Connection, words: &str, limit: i64) -> rusqlite::Result<Vec<(String, String)>> {
    let ws: Vec<String> = words.to_lowercase().split_whitespace().filter(|w| w.len() > 2).map(|w| format!("%{}%", w.replace('%', ""))).collect();
    if ws.is_empty() {
        return Ok(vec![]);
    }
    let cond = ws.iter().enumerate().map(|(i, _)| format!("lower(name) LIKE ?{}", i + 1)).collect::<Vec<_>>().join(" OR ");
    let mut st = c.prepare(&format!("SELECT path, name FROM doc_files WHERE error IS NULL AND ({cond}) ORDER BY modified DESC LIMIT {limit}"))?;
    let rows = st.query_map(rusqlite::params_from_iter(ws.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

// ---------------------------------------------------------------------------
// Indexing

static RUNNING: AtomicBool = AtomicBool::new(false);
static DONE: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Serialize, Default)]
pub struct IndexReport {
    pub indexed: usize,
    pub unchanged: usize,
    pub removed: usize,
    pub unreadable: usize,
}

fn walk(g: &Guard, roots: &[PathBuf]) -> Vec<(PathBuf, u64, i64)> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = roots.iter().filter(|r| r.is_dir()).cloned().collect();
    while let Some(d) = stack.pop() {
        if g.check_usable(&d).is_err() {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_lowercase();
            let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
            if md.file_type().is_symlink() || name.starts_with('.') || name.starts_with("~$") {
                continue;
            }
            if md.is_dir() {
                if !matches!(name.as_str(), "node_modules" | "appdata" | "$recycle.bin" | "system volume information") {
                    stack.push(p);
                }
                continue;
            }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !SUPPORTED.contains(&ext.as_str()) || md.len() == 0 {
                continue;
            }
            let modified = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.push((p, md.len(), modified));
            if out.len() >= MAX_FILES {
                return out;
            }
        }
    }
    out
}

pub fn index_folders(state: &AppState, roots: &[PathBuf]) -> BevResult<IndexReport> {
    let g = Guard::from_env();
    let files = walk(&g, roots);
    TOTAL.store(files.len(), Ordering::SeqCst);
    DONE.store(0, Ordering::SeqCst);
    let mut rep = IndexReport::default();
    let seen: std::collections::HashSet<String> = files.iter().map(|f| f.0.display().to_string()).collect();
    for (p, size, modified) in &files {
        let path = p.display().to_string();
        let known = known_sql(&state.db.lock().unwrap(), &path)?;
        if matches!(known, Some((_, s, m)) if s == *size as i64 && m == *modified) {
            rep.unchanged += 1;
        } else if *size > MAX_FILE_BYTES {
            store_sql(&mut state.db.lock().unwrap(), &path, &file_name(p), *size as i64, *modified, Err("too big to read"))?;
            rep.unreadable += 1;
        } else {
            let text = extract(p); // no lock held here
            let mut c = state.db.lock().unwrap();
            match &text {
                Ok(pages) => {
                    store_sql(&mut c, &path, &file_name(p), *size as i64, *modified, Ok(pages))?;
                    rep.indexed += 1;
                }
                Err(e) => {
                    store_sql(&mut c, &path, &file_name(p), *size as i64, *modified, Err(e))?;
                    rep.unreadable += 1;
                }
            }
        }
        DONE.fetch_add(1, Ordering::SeqCst);
    }
    // Forget files that were deleted, or are no longer in a chosen folder.
    let c = state.db.lock().unwrap();
    let all: Vec<(i64, String)> = c.prepare("SELECT id, path FROM doc_files")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    for (id, path) in all {
        if !seen.contains(&path) {
            remove_sql(&c, id)?;
            rep.removed += 1;
        }
    }
    Ok(rep)
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Commands

#[derive(Serialize)]
pub struct DocStatus {
    pub files: i64,
    pub passages: i64,
    pub unreadable: i64,
    pub running: bool,
    pub done: usize,
    pub total: usize,
}

#[tauri::command]
pub async fn docs_index(app: tauri::AppHandle, folders: Vec<String>) -> BevResult<IndexReport> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err(BevError::Invalid("BEV is already reading your documents".into()));
    }
    let roots: Vec<PathBuf> = folders.iter().map(|f| PathBuf::from(expand(f))).filter(|p| p.is_absolute()).collect();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        index_folders(&state, &roots)
    })
    .await;
    RUNNING.store(false, Ordering::SeqCst);
    res.map_err(|e| BevError::Os(e.to_string()))?
}

#[tauri::command]
pub fn docs_status(state: tauri::State<AppState>) -> BevResult<DocStatus> {
    let c = state.db.lock().unwrap();
    let files: i64 = c.query_row("SELECT count(*) FROM doc_files WHERE error IS NULL", [], |r| r.get(0))?;
    let unreadable: i64 = c.query_row("SELECT count(*) FROM doc_files WHERE error IS NOT NULL", [], |r| r.get(0))?;
    let passages: i64 = c.query_row("SELECT count(*) FROM doc_chunks", [], |r| r.get(0))?;
    Ok(DocStatus { files, passages, unreadable, running: RUNNING.load(Ordering::SeqCst), done: DONE.load(Ordering::SeqCst), total: TOTAL.load(Ordering::SeqCst) })
}

#[derive(Serialize)]
pub struct DocSearch {
    pub hits: Vec<DocHit>,
    /// Indexed files whose names match the question.
    pub named: Vec<DocHit>,
}

#[tauri::command]
pub fn docs_search(state: tauri::State<AppState>, query: String, limit: Option<i64>) -> BevResult<DocSearch> {
    let c = state.db.lock().unwrap();
    let hits = search_sql(&c, &query, limit.unwrap_or(8).clamp(1, 30))?;
    let named = by_name_sql(&c, &query, 5)?.into_iter().map(|(path, name)| DocHit { path, name, page: 0, snippet: String::new() }).collect();
    Ok(DocSearch { hits, named })
}

#[derive(Serialize)]
pub struct DocText {
    pub name: String,
    pub pages: usize,
    pub from_page: usize,
    pub to_page: usize,
    pub text: String,
    pub truncated: bool,
}

/// Read a document's text (any supported file the user can reach, indexed or not).
#[tauri::command]
pub async fn docs_read(path: String, page: Option<usize>) -> BevResult<DocText> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(expand(&path));
        if !p.is_absolute() || !p.is_file() {
            return Err(BevError::NotFound(format!("{} isn't a file BEV can find", p.display())));
        }
        Guard::from_env().check_usable(&p).map_err(BevError::Invalid)?;
        if std::fs::metadata(&p)?.len() > MAX_FILE_BYTES {
            return Err(BevError::Invalid("that file is too big to read".into()));
        }
        let pages = extract(&p).map_err(BevError::Invalid)?;
        let from = page.unwrap_or(1).max(1).min(pages.len().max(1));
        let mut text = String::new();
        let mut to = from;
        let mut truncated = false;
        for (i, pg) in pages.iter().enumerate().skip(from - 1) {
            if !text.is_empty() && text.len() + pg.len() > READ_LIMIT {
                truncated = true;
                break;
            }
            if pages.len() > 1 {
                text.push_str(&format!("--- page {} ---\n", i + 1));
            }
            to = i + 1;
            if pg.len() > READ_LIMIT {
                let mut cut = READ_LIMIT;
                while !pg.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.push_str(&pg[..cut]);
                truncated = true;
                break;
            }
            text.push_str(pg);
            text.push('\n');
        }
        Ok(DocText { name: file_name(&p), pages: pages.len(), from_page: from, to_page: to.max(from), text, truncated })
    })
    .await
    .map_err(|e| BevError::Os(e.to_string()))?
}

#[tauri::command]
pub fn docs_clear(state: tauri::State<AppState>) -> BevResult<()> {
    let c = state.db.lock().unwrap();
    c.execute_batch("DELETE FROM doc_chunks; DELETE FROM doc_files; INSERT INTO doc_fts(doc_fts) VALUES ('rebuild');")?;
    Ok(())
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
    fn xml_and_entities() {
        let x = r#"<w:p><w:r><w:t>Rent is &pound;950 &amp; due</w:t></w:r></w:p><w:p><w:t xml:space="preserve">on the 1st&#8217;s</w:t></w:p>"#;
        assert_eq!(xml_text(x, &["w:p"]).trim(), "Rent is &pound;950 & due\non the 1st’s");
        let h = "<html><style>p{x}</style><p>Hi <b>there</b></p><script>alert(1)</script><p>Bye</p>";
        assert_eq!(tidy(&xml_text(h, &["p"])), "Hi there\nBye");
    }

    #[test]
    fn rtf_basics() {
        let r = r"{\rtf1\ansi{\fonttbl{\f0 Arial;}}{\colortbl;\red0;}\f0 Hello\par World \'e9t\'e9}";
        assert_eq!(tidy(&rtf_text(r)), "Hello\nWorld été");
    }

    #[test]
    fn chunks_respect_size_and_keep_everything() {
        let para = "This is a sentence. ".repeat(200);
        let page = format!("Short intro\n\n{para}\nEnd line");
        let cs = chunks(&page);
        assert!(cs.len() >= 3);
        assert!(cs.iter().all(|c| c.len() <= CHUNK_CHARS + 50), "{:?}", cs.iter().map(|c| c.len()).collect::<Vec<_>>());
        let joined: String = cs.join(" ");
        assert!(joined.contains("Short intro") && joined.contains("End line"));
    }

    #[test]
    fn store_search_replace_and_remove() {
        let mut c = db();
        let pages = vec!["The tenancy starts on 1 March.\nThe deposit is £1,200 and is protected.".to_string(), "Pets are not allowed without written consent.".to_string()];
        store_sql(&mut c, "C:/Docs/Lease.pdf", "Lease.pdf", 100, 1, Ok(&pages)).unwrap();
        store_sql(&mut c, "C:/Docs/Car.docx", "Car.docx", 50, 1, Ok(&["Insurance renews in June.".to_string()])).unwrap();
        let hits = search_sql(&c, "deposits", 5).unwrap(); // stemming
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].name.as_str(), hits[0].page), ("Lease.pdf", 1));
        assert!(hits[0].snippet.contains("[deposit]"));
        assert_eq!(search_sql(&c, "pets", 5).unwrap()[0].page, 2);
        // Re-storing replaces old passages.
        store_sql(&mut c, "C:/Docs/Lease.pdf", "Lease.pdf", 120, 2, Ok(&["Dogs allowed.".to_string()])).unwrap();
        assert!(search_sql(&c, "deposit", 5).unwrap().is_empty());
        assert_eq!(known_sql(&c, "C:/Docs/Lease.pdf").unwrap().map(|k| (k.1, k.2)), Some((120, 2)));
        // Unreadable files are recorded without passages.
        store_sql(&mut c, "C:/Docs/Secret.pdf", "Secret.pdf", 9, 1, Err("encrypted")).unwrap();
        assert_eq!(by_name_sql(&c, "secret", 5).unwrap().len(), 0);
        assert_eq!(by_name_sql(&c, "my lease", 5).unwrap()[0].1, "Lease.pdf");
        let id = known_sql(&c, "C:/Docs/Car.docx").unwrap().unwrap().0;
        remove_sql(&c, id).unwrap();
        assert!(search_sql(&c, "insurance", 5).unwrap().is_empty());
    }

    #[test]
    fn extracts_plain_text_and_docx() {
        let d = std::env::temp_dir().join(format!("bev-docs-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.md"), "# Title\n\n\n\nBody   text").unwrap();
        assert_eq!(extract(&d.join("a.md")).unwrap(), vec!["# Title\n\nBody text".to_string()]);
        // A minimal .docx: just the document part.
        let f = std::fs::File::create(d.join("b.docx")).unwrap();
        let mut z = zip::ZipWriter::new(f);
        z.start_file("word/document.xml", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut z, b"<w:document><w:body><w:p><w:t>Hello</w:t></w:p><w:p><w:t>World</w:t></w:p></w:body></w:document>").unwrap();
        z.finish().unwrap();
        assert_eq!(extract(&d.join("b.docx")).unwrap(), vec!["Hello\nWorld".to_string()]);
        assert!(extract(&d.join("nope.xyz")).is_err());
        std::fs::write(d.join("broken.docx"), "not a zip").unwrap();
        assert!(extract(&d.join("broken.docx")).is_err());
    }
}
