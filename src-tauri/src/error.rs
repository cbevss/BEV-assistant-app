//! Unified error type. Serialises to a string so the frontend sees a readable
//! message rather than a fabricated success.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum BevError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("db: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("secret store: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("not supported on this device: {0}")]
    Unsupported(String),
    #[error("invalid argument: {0}")]
    Invalid(String),
    #[error("os call failed: {0}")]
    Os(String),
    #[error("not found: {0}")]
    NotFound(String),
}

impl Serialize for BevError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type BevResult<T> = Result<T, BevError>;
