//! API credentials via the Windows Credential Manager (keyring crate).
//! Keys are never written to SQLite, logs, or the frontend store.

use crate::error::{BevError, BevResult};

const SERVICE: &str = "com.cbevss.bev";

fn entry(name: &str) -> BevResult<keyring::Entry> {
    if name.trim().is_empty() {
        return Err(BevError::Invalid("secret name is empty".into()));
    }
    Ok(keyring::Entry::new(SERVICE, name)?)
}

#[tauri::command]
pub fn store_secret(name: String, value: String) -> BevResult<()> {
    entry(&name)?.set_password(&value)?;
    Ok(())
}

/// Returns whether a secret exists and its value. Frontend uses this only to
/// unlock a provider; it should not echo the value into the UI.
#[tauri::command]
pub fn get_secret(name: String) -> BevResult<Option<String>> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub fn delete_secret(name: String) -> BevResult<()> {
    match entry(&name)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
