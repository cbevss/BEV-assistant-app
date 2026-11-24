//! Pictures the user attaches to a message (from the file picker or dragged
//! onto BEV). Only image files, only up to a size limit, read on request.

use crate::error::{BevError, BevResult};
use base64::Engine;
use serde::Serialize;

const MAX_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Serialize)]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// Base64 bytes.
    pub data: String,
}

/// The image type for a file name, or None if it isn't a picture BEV can show the AI.
pub fn image_mime(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

#[tauri::command]
pub async fn read_image_attachment(path: String) -> BevResult<Attachment> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mime = image_mime(&name).ok_or_else(|| BevError::Invalid(format!("{name} isn't a picture")))?;
        let meta = std::fs::metadata(&p).map_err(|e| BevError::NotFound(format!("{name}: {e}")))?;
        if !meta.is_file() {
            return Err(BevError::Invalid(format!("{name} isn't a file")));
        }
        if meta.len() > MAX_BYTES {
            return Err(BevError::Invalid(format!("{name} is too big to attach (over 25 MB)")));
        }
        let bytes = std::fs::read(&p).map_err(|e| BevError::Os(format!("read {name}: {e}")))?;
        Ok(Attachment { name, mime: mime.into(), size: meta.len(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
    })
    .await
    .map_err(|e| BevError::Os(format!("attach: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::image_mime;
    #[test]
    fn picks_image_types() {
        assert_eq!(image_mime("shot.PNG"), Some("image/png"));
        assert_eq!(image_mime("a.b.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime("report.pdf"), None);
        assert_eq!(image_mime("noext"), None);
    }
}

/// File types that could run code if opened: not accepted from the phone.
pub fn runnable(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "exe" | "msi" | "msix" | "appx" | "bat" | "cmd" | "com" | "ps1" | "psm1" | "vbs" | "vbe" | "js" | "jse" | "wsf" | "wsh" | "scr" | "pif" | "lnk" | "url" | "hta" | "cpl" | "reg" | "jar" | "dll" | "sys"
    )
}

/// A safe file name: no folders, no reserved characters, not empty.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .chars()
        .take(120)
        .collect();
    if cleaned.is_empty() { "file".into() } else { cleaned }
}

const MAX_PHONE_FILE: usize = 10 * 1024 * 1024;

/// Save a file sent from the user's phone into BEV\From phone (in the user's home folder) and
/// return its path. Programs and scripts are refused; nothing is opened.
#[tauri::command]
pub async fn save_phone_file(name: String, data: String) -> BevResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = safe_name(&name);
        if runnable(&name) {
            return Err(BevError::Invalid(format!("{name} is a program or script, so BEV won't save it from your phone")));
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|_| BevError::Invalid("the file was damaged on the way".into()))?;
        if bytes.len() > MAX_PHONE_FILE {
            return Err(BevError::Invalid(format!("{name} is too big (over 10 MB)")));
        }
        let dir = crate::folders::sub("From phone")?;
        // Don't overwrite: "photo.jpg", "photo (2).jpg", …
        let (stem, ext) = match name.rfind('.') {
            Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
            _ => (name.clone(), String::new()),
        };
        let mut path = dir.join(&name);
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        std::fs::write(&path, bytes).map_err(|e| BevError::Os(format!("save {name}: {e}")))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| BevError::Os(format!("save: {e}")))?
}

#[cfg(test)]
mod phone_tests {
    use super::{runnable, safe_name};
    #[test]
    fn names() {
        assert_eq!(safe_name("..\\..\\Windows\\evil.txt"), "evil.txt");
        assert_eq!(safe_name("a<b>:c?.pdf"), "a_b__c_.pdf");
        assert_eq!(safe_name("..."), "file");
        assert!(runnable("setup.EXE"));
        assert!(runnable("x.ps1"));
        assert!(!runnable("photo.jpg"));
    }
}
