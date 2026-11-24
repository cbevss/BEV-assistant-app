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
