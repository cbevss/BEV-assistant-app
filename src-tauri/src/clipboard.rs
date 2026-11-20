//! Clipboard text, for "copy that" and "what did I copy?". Text only.

use crate::error::{BevError, BevResult};

const MAX_READ: usize = 100_000;

#[tauri::command]
pub fn clipboard_read() -> BevResult<String> {
    let mut c = arboard::Clipboard::new().map_err(|e| BevError::Os(format!("clipboard unavailable: {e}")))?;
    match c.get_text() {
        Ok(t) => Ok(if t.len() > MAX_READ {
            let mut cut = MAX_READ;
            while !t.is_char_boundary(cut) {
                cut -= 1;
            }
            t[..cut].to_string()
        } else {
            t
        }),
        // Empty or not text (an image, files): report as nothing.
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(BevError::Os(format!("couldn't read the clipboard: {e}"))),
    }
}

#[tauri::command]
pub fn clipboard_write(text: String) -> BevResult<()> {
    if text.len() > 1_000_000 {
        return Err(BevError::Invalid("that's too much text to copy".into()));
    }
    let mut c = arboard::Clipboard::new().map_err(|e| BevError::Os(format!("clipboard unavailable: {e}")))?;
    c.set_text(text).map_err(|e| BevError::Os(format!("couldn't copy: {e}")))
}

/// The image on the clipboard (a copied screenshot or picture), shrunk and
/// encoded like a screenshot. None when the clipboard holds no image.
#[tauri::command]
pub async fn clipboard_image() -> BevResult<Option<crate::screen::ScreenCapture>> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut c = arboard::Clipboard::new().map_err(|e| BevError::Os(format!("clipboard unavailable: {e}")))?;
        match c.get_image() {
            Ok(img) => {
                let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned()).ok_or_else(|| BevError::Os("the copied image looks damaged".into()))?;
                Ok(Some(crate::screen::encode(rgba, "copied image".into())?))
            }
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(BevError::Os(format!("couldn't read the clipboard image: {e}"))),
        }
    })
    .await
    .map_err(|e| BevError::Os(e.to_string()))?
}
