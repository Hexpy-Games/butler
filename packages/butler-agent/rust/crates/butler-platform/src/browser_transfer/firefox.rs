//! Firefox/Zen key4.db and logins.json. Primary passwords are never persisted.
use super::{ImportError, Login, Snapshot, nss, read, sql_error};
use crate::secrets::SecretText;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::Path;
use zeroize::Zeroizing;

pub(super) fn passwords(
    dir: &Path,
    primary: &SecretText,
    scratch: &Path,
) -> Result<Vec<Login>, ImportError> {
    let path = dir.join("logins.json");
    if !path.try_exists().map_err(|e| super::io_error(&e))? {
        return Ok(Vec::new());
    }
    let bytes = read(&path, 16 * 1024 * 1024)?;
    let data: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| ImportError::Format)?;
    let snapshot = Snapshot::new(&dir.join("key4.db"), scratch)?;
    let key = decrypt_key(&snapshot.path, primary)?;
    let rows = data
        .get("logins")
        .and_then(serde_json::Value::as_array)
        .ok_or(ImportError::Format)?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let username = decrypt_login(
            row.get("encryptedUsername")
                .and_then(serde_json::Value::as_str),
            &key,
        )?;
        let password = decrypt_login(
            row.get("encryptedPassword")
                .and_then(serde_json::Value::as_str),
            &key,
        )?;
        result.push(Login {
            origin: row
                .get("hostname")
                .and_then(serde_json::Value::as_str)
                .ok_or(ImportError::Format)?
                .into(),
            username,
            password,
        });
    }
    Ok(result)
}

fn decrypt_key(path: &Path, primary: &SecretText) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let db = rusqlite::Connection::open(path).map_err(|e| sql_error(&e))?;
    let (global, check): (Vec<u8>, Vec<u8>) = db
        .query_row(
            "SELECT item1,item2 FROM metadata WHERE id='password'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| sql_error(&e))?;
    let check = nss::pbe(&check, &global, primary.expose().as_bytes());
    if matches!(check, Err(ImportError::Format | ImportError::TooLarge)) {
        return Err(ImportError::Format);
    }
    if !check
        .as_ref()
        .is_ok_and(|text| text.as_slice() == b"password-check")
    {
        return Err(if primary.expose().is_empty() {
            ImportError::PrimaryPassword
        } else {
            ImportError::IncorrectPassword
        });
    }
    let encrypted: Vec<u8> = db
        .query_row(
            "SELECT a11 FROM nssPrivate WHERE a102=x'f8000000000000000000000000000001'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| sql_error(&e))?;
    let key = nss::pbe(&encrypted, &global, primary.expose().as_bytes())?;
    if key.len() != 24 {
        return Err(ImportError::Format);
    }
    Ok(key)
}

fn decrypt_login(encoded: Option<&str>, key: &[u8]) -> Result<SecretText, ImportError> {
    let encoded = STANDARD
        .decode(encoded.ok_or(ImportError::Format)?)
        .map_err(|_| ImportError::Format)?;
    let clear = nss::login(&encoded, key)?;
    let text = std::str::from_utf8(&clear).map_err(|_| ImportError::Format)?;
    Ok(SecretText::new(text.into()))
}
