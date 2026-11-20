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
