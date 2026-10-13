//! Windows Chromium v10 AES-GCM with a current-user DPAPI key.
use super::super::{ImportError, Login, LoginBatch, SafeStorageKeySource, Snapshot, sql_error};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::Path;
use zeroize::Zeroizing;

pub(super) fn passwords(
    _browser: &str,
    dir: &Path,
    scratch: &Path,
    _keys: &dyn SafeStorageKeySource,
) -> Result<LoginBatch, ImportError> {
    let source = dir.join("Login Data");
    if !source
        .try_exists()
        .map_err(|e| super::super::io_error(&e))?
    {
        return Ok(LoginBatch::default());
    }
    let snapshot = Snapshot::new(&source, scratch)?;
    let db = rusqlite::Connection::open(&snapshot.path).map_err(|e| sql_error(&e))?;
    let columns = db
        .prepare("PRAGMA table_info(logins)")
        .map_err(|e| sql_error(&e))?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| sql_error(&e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| sql_error(&e))?;
    let time = |name: &str| {
        if columns.iter().any(|c| c == name) {
            name
        } else {
            "0"
        }
    };
    let query = format!(
        "SELECT origin_url,username_value,password_value,max(coalesce({},0),coalesce({},0)) FROM logins WHERE blacklisted_by_user=0 ORDER BY rowid",
        time("date_last_used"),
        time("date_password_modified")
    );
    let mut statement = db.prepare(&query).map_err(|e| sql_error(&e))?;
    let mut rows = statement.query([]).map_err(|e| sql_error(&e))?;
    // Resolve once, lazily: a v20-only profile does not need a legacy key.
    let mut key = None;
    let mut batch = LoginBatch::default();
    while let Some(row) = rows.next().map_err(|e| sql_error(&e))? {
        let encrypted = Zeroizing::new(row.get::<_, Vec<u8>>(2).map_err(|e| sql_error(&e))?);
        if encrypted.is_empty() {
            continue;
        }
        if encrypted.starts_with(b"v20") {
            batch.csv_required += 1;
            continue;
        }
        if key.is_none() {
            key = Some(master_key(dir));
        }
        let result = key
            .as_ref()
            .unwrap()
            .as_ref()
            .map_err(|e| *e)
            .and_then(|key| decrypt_row(row, &encrypted, key));
        match result {
            Ok(login) => batch.logins.push(login),
            Err(ImportError::CsvRequired) => batch.csv_required += 1,
            Err(_) => batch.invalid += 1,
        }
    }
    Ok(batch)
}

fn master_key(dir: &Path) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let path = dir
        .parent()
        .ok_or(ImportError::NotFound)?
        .join("Local State");
    let bytes = super::super::read(&path, 16 * 1024 * 1024)?;
    let state: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| ImportError::Format)?;
    let encoded = state["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or(ImportError::CsvRequired)?;
    let protected = Zeroizing::new(STANDARD.decode(encoded).map_err(|_| ImportError::Format)?);
    let blob = protected
        .strip_prefix(b"DPAPI")
        .ok_or(ImportError::CsvRequired)?;
    let key = Zeroizing::new(
        windows_dpapi::decrypt_data(blob, windows_dpapi::Scope::User, None)
            .map_err(|_| ImportError::CsvRequired)?,
    );
    if key.len() != 32 {
        return Err(ImportError::Format);
    }
    Ok(key)
}

fn decrypt_row(
    row: &rusqlite::Row<'_>,
    encrypted: &[u8],
    key: &[u8],
) -> Result<Login, ImportError> {
    use crate::secrets::SecretText;
    let payload = encrypted
        .strip_prefix(b"v10")
        .ok_or(ImportError::CsvRequired)?;
    if payload.len() < 12 + 16 {
        return Err(ImportError::Format);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ImportError::Format)?;
    let decrypted = Zeroizing::new(
        cipher
            .decrypt(Nonce::from_slice(&payload[..12]), &payload[12..])
            .map_err(|_| ImportError::Format)?,
    );
    let password = std::str::from_utf8(&decrypted).map_err(|_| ImportError::Format)?;
    let chrome_time: Option<i64> = row.get(3).map_err(|e| sql_error(&e))?;
    Ok(Login {
        origin: row.get(0).map_err(|e| sql_error(&e))?,
        username: SecretText::new(row.get(1).map_err(|e| sql_error(&e))?),
        password: SecretText::new(password.into()),
        modified_ms: chrome_time
            .filter(|t| *t > 0)
            .map(|t| t / 1000 - 11_644_473_600_000),
    })
}
