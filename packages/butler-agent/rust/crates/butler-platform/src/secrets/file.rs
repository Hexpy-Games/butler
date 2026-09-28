//! The owner-only secret file: `{"version":1,"secrets":[{"service","account",
//! "secret"}]}`, replaced atomically on every change (see
//! [`secure_fs::replace_private`]) and opened without following a symbolic
//! link. It holds secrets where the system store cannot, so it is only as
//! private as the data folder's owner-only permissions make it.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{SecretError, SecretKey, SecretText};
use crate::secure_fs;

/// The file format this module reads and writes.
const VERSION: u64 = 1;

/// Serializes the read-modify-write cycles of every secret file in this
/// process, so two changes cannot drop each other.
static CHANGES: Mutex<()> = Mutex::new(());

pub(super) struct FileSecrets {
    path: PathBuf,
}

struct Entry {
    service: String,
    account: String,
    secret: Zeroizing<String>,
}

impl Entry {
    fn matches(&self, key: &SecretKey) -> bool {
        self.service == key.service && self.account == key.account
    }
}

impl FileSecrets {
    pub(super) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(super) fn get(&self, key: &SecretKey) -> Result<Option<SecretText>, SecretError> {
        Ok(self
            .read()?
            .into_iter()
            .find(|entry| entry.matches(key))
            .map(|entry| SecretText(entry.secret)))
    }

    pub(super) fn set(&self, key: &SecretKey, secret: &str) -> Result<(), SecretError> {
        let _change = CHANGES.lock().unwrap_or_else(PoisonError::into_inner);
        let mut entries = self.read()?;
        entries.retain(|entry| !entry.matches(key));
        entries.push(Entry {
            service: key.service.clone(),
            account: key.account.clone(),
            secret: Zeroizing::new(secret.to_owned()),
        });
        self.write(&entries)
    }

    pub(super) fn delete(&self, key: &SecretKey) -> Result<bool, SecretError> {
        let _change = CHANGES.lock().unwrap_or_else(PoisonError::into_inner);
        let mut entries = self.read()?;
        let before = entries.len();
        entries.retain(|entry| !entry.matches(key));
        if entries.len() == before {
            return Ok(false);
        }
        self.write(&entries)?;
        Ok(true)
    }

    /// Every entry; none when the file does not exist yet.
    fn read(&self) -> Result<Vec<Entry>, SecretError> {
        let mut file = match secure_fs::open_read_no_follow(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(SecretError::File(error)),
        };
        let mut bytes = Zeroizing::new(Vec::new());
        file.read_to_end(&mut bytes).map_err(SecretError::File)?;
        // Parsed as a plain value: its syntax errors name a position, never
        // the text around it.
        let value: Value = serde_json::from_slice(&bytes).map_err(SecretError::FileFormat)?;
        decode(&value)
    }

    fn write(&self, entries: &[Entry]) -> Result<(), SecretError> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            secure_fs::create_private_dir_all(parent).map_err(SecretError::File)?;
        }
        let secrets: Vec<Value> = entries
            .iter()
            .map(|entry| {
                json!({
                    "service": entry.service,
                    "account": entry.account,
                    "secret": entry.secret.as_str(),
                })
            })
            .collect();
        let document = json!({"version": VERSION, "secrets": secrets});
        let mut bytes =
            Zeroizing::new(serde_json::to_vec_pretty(&document).map_err(SecretError::FileFormat)?);
        bytes.push(b'\n');
        secure_fs::replace_private(
            &self.path,
            |file| file.write_all(&bytes),
            std::convert::identity,
        )
        .map_err(SecretError::File)
    }
}

fn decode(value: &Value) -> Result<Vec<Entry>, SecretError> {
    if value.get("version").and_then(Value::as_u64) != Some(VERSION) {
        return Err(SecretError::FileShape);
    }
    let entries = value
        .get("secrets")
        .and_then(Value::as_array)
        .ok_or(SecretError::FileShape)?;
    entries
        .iter()
        .map(|entry| {
            let field = |name: &str| {
                entry
                    .get(name)
                    .and_then(Value::as_str)
                    .ok_or(SecretError::FileShape)
            };
            Ok(Entry {
                service: field("service")?.to_owned(),
                account: field("account")?.to_owned(),
                secret: Zeroizing::new(field("secret")?.to_owned()),
            })
        })
        .collect()
}
