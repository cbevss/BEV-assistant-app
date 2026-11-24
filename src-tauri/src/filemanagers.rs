//! File managers installed on this PC (File Explorer, Slate, Files, Directory Opus, Total Commander…), so the user can
//! pick which one BEV opens folders in. Windows doesn't always hand folders to a replacement file manager, so BEV
//! starts the chosen one itself with the folder.

use crate::error::{BevError, BevResult};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct FileManager {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(skip)]
    pub exe: PathBuf,
}

/// (id, name, places to look under Program Files / LocalAppData / WindowsApps aliases, how to pass the folder)
const KNOWN: &[(&str, &str, &[&str], Args)] = &[
    ("slate", "Slate", &[r"%LOCALAPPDATA%\Slate\Slate.exe", r"%LOCALAPPDATA%\Programs\Slate\Slate.exe", r"%ProgramFiles%\Slate\Slate.exe"], Args::Plain),
    ("files", "Files", &[r"%LOCALAPPDATA%\Microsoft\WindowsApps\files.exe", r"%LOCALAPPDATA%\Microsoft\WindowsApps\Files.App.exe"], Args::Plain),
    ("dopus", "Directory Opus", &[r"%ProgramFiles%\GPSoftware\Directory Opus\dopus.exe"], Args::Plain),
    ("totalcmd", "Total Commander", &[r"%COMMANDER_PATH%\TOTALCMD64.EXE", r"C:\totalcmd\TOTALCMD64.EXE", r"%ProgramFiles%\totalcmd\TOTALCMD64.EXE", r"C:\totalcmd\TOTALCMD.EXE"], Args::TotalCmd),
    ("xyplorer", "XYplorer", &[r"%ProgramFiles%\XYplorer\XYplorer.exe", r"%ProgramFiles(x86)%\XYplorer\XYplorer.exe", r"%LOCALAPPDATA%\Programs\XYplorer\XYplorer.exe"], Args::Plain),
    ("onecommander", "One Commander", &[r"%LOCALAPPDATA%\Microsoft\WindowsApps\OneCommander.exe", r"%ProgramFiles%\OneCommander\OneCommander.exe", r"%LOCALAPPDATA%\OneCommander\OneCommander.exe"], Args::Plain),
    ("explorerpp", "Explorer++", &[r"%ProgramFiles%\Explorer++\Explorer++.exe", r"%LOCALAPPDATA%\Programs\Explorer++\Explorer++.exe"], Args::Plain),
    ("qdir", "Q-Dir", &[r"%ProgramFiles%\Q-Dir\Q-Dir.exe", r"%ProgramFiles(x86)%\Q-Dir\Q-Dir.exe"], Args::Plain),
    ("freecommander", "FreeCommander", &[r"%ProgramFiles%\FreeCommander XE\FreeCommander.exe", r"%ProgramFiles(x86)%\FreeCommander XE\FreeCommander.exe"], Args::Plain),
    ("doublecmd", "Double Commander", &[r"%ProgramFiles%\Double Commander\doublecmd.exe"], Args::Plain),
];

#[derive(Debug, Clone, Copy)]
enum Args {
    Plain,
    TotalCmd,
}

fn expand(p: &str) -> Option<PathBuf> {
    let mut out = String::new();
    let mut rest = p;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let j = after.find('%')?;
        out.push_str(&std::env::var(&after[..j]).ok()?);
        rest = &after[j + 1..];
    }
    out.push_str(rest);
    Some(PathBuf::from(out))
}

fn found(paths: &[&str]) -> Option<PathBuf> {
    paths.iter().filter_map(|p| expand(p)).find(|p| p.is_file())
}

/// File Explorer first, then every other file manager found.
#[tauri::command]
pub fn list_file_managers() -> Vec<FileManager> {
    let mut out = vec![FileManager { id: "explorer", name: "File Explorer", exe: PathBuf::from("explorer.exe") }];
    for (id, name, paths, _) in KNOWN {
        if let Some(exe) = found(paths) {
            out.push(FileManager { id, name, exe });
        }
    }
    out
}

/// The command line for opening `folder` in a file manager. Pure; tested.
pub(crate) fn args_for(id: &str, folder: &Path) -> Vec<String> {
    let f = folder.display().to_string();
    match KNOWN.iter().find(|k| k.0 == id).map(|k| k.3) {
        Some(Args::TotalCmd) => vec!["/O".into(), "/T".into(), format!("/L={f}")],
        _ => vec![f],
    }
}

/// Open a folder in the chosen file manager. Ok(false) when that one isn't installed (use the default).
pub fn open_folder_in(id: &str, folder: &Path) -> BevResult<bool> {
    if id.is_empty() || id == "system" {
        return Ok(false);
    }
    let Some(fm) = list_file_managers().into_iter().find(|m| m.id == id) else { return Ok(false) };
    std::process::Command::new(&fm.exe)
        .args(args_for(id, folder))
        .spawn()
        .map_err(|e| BevError::Os(format!("couldn't start {}: {e}", fm.name)))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_each_file_managers_command_line() {
        let f = Path::new(r"C:\Users\me\BEV");
        assert_eq!(args_for("files", f), vec![r"C:\Users\me\BEV".to_string()]);
        assert_eq!(args_for("slate", f), vec![r"C:\Users\me\BEV".to_string()]);
        assert_eq!(args_for("totalcmd", f), vec!["/O".to_string(), "/T".to_string(), r"/L=C:\Users\me\BEV".to_string()]);
    }

    #[test]
    fn file_explorer_is_always_listed_first() {
        assert_eq!(list_file_managers()[0].id, "explorer");
        assert!(expand("%BEV_SURELY_NOT_SET_42%\\x").is_none());
    }
}
