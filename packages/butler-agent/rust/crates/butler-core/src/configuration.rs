//! Shared serialization of synchronous-source configuration write sequences.
//! The composition root passes the same owner to every configuration writer.
//! Domains retain normalization and file/DB ordering; this is not a transaction
//! and it never rolls back already completed writes or retains snapshots.

use std::{collections::HashMap, fs, io::Write, path::Path, sync::Arc};

use butler_platform::secure_fs;
use tokio::sync::{Mutex, MutexGuard, OwnedMutexGuard};

/// Failures reading or writing the shared user configuration files.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The private environment file exists but could not be read.
    #[error("Private environment file could not be read.")]
    EnvironmentUnreadable(#[source] std::io::Error),
    /// The configuration file exists but could not be read.
    #[error("Config file could not be read.")]
    Unreadable(#[source] std::io::Error),
    /// The configuration file is not valid JSON.
    #[error("config JSON parse failed: {0}")]
    Parse(#[source] serde_json::Error),
    /// The configuration file's root is not a JSON object.
    #[error("config root must be an object")]
    NotAnObject,
    /// The configuration path has no parent directory.
    #[error("Configuration path is invalid.")]
    InvalidPath,
    /// The configuration directory could not be created.
    #[error("Config directory could not be created.")]
    DirectoryUnavailable(#[source] std::io::Error),
    /// Writing, syncing or renaming the temporary configuration file failed.
    #[error("Config write failed.")]
    WriteFailed(#[source] std::io::Error),
}

/// Serializes read/modify/write cycles of the configuration file within this process.
pub struct ConfigurationWrites {
    gate: Arc<Mutex<()>>,
}

/// Read the private DATA-scoped environment file without mutating the process.
/// A nonempty process variable remains authoritative at the composition edge.
pub fn read_private_environment(path: &Path) -> Result<HashMap<String, String>, ConfigError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(ConfigError::EnvironmentUnreadable(error)),
    };
    let mut values = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut value = raw.trim();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        values.insert(key.to_owned(), value.to_owned());
    }
    Ok(values)
}

impl Default for ConfigurationWrites {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigurationWrites {
    /// A gate with no write in progress.
    pub fn new() -> Self {
        Self {
            gate: Arc::new(Mutex::new(())),
        }
    }

    /// Acquire before a source-synchronous read/modify/write sequence. Drop
    /// before provider/network work; cancellation releases the borrowed guard.
    pub async fn acquire(&self) -> MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    /// A tracked blocking operation moves this permit into its closure so a
    /// dropped caller cannot unlock while the actual file mutation continues.
    pub async fn acquire_owned(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.gate).lock_owned().await
    }
}

/// Read the shared user configuration without initializing its parent DATA directory.
/// Missing files have the same empty-object default as the operator CLI.
pub fn read_json_object(path: &Path) -> Result<serde_json::Value, ConfigError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::Value::Object(serde_json::Map::new()));
        }
        Err(error) => return Err(ConfigError::Unreadable(error)),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(ConfigError::Parse)?;
    if !value.is_object() {
        return Err(ConfigError::NotAnObject);
    }
    Ok(value)
}

/// Atomically replace a user-owned JSON file with a private temporary file.
pub fn write_json_atomic(path: &Path, value: &serde_json::Value) -> Result<(), ConfigError> {
    let parent = path.parent().ok_or(ConfigError::InvalidPath)?;
    secure_fs::create_private_dir_all(parent).map_err(ConfigError::DirectoryUnavailable)?;
    secure_fs::replace_private(
        path,
        |file| {
            serde_json::to_writer_pretty(&mut *file, value)?;
            file.write_all(b"\n")
        },
        std::convert::identity,
    )
    .map_err(ConfigError::WriteFailed)
}
