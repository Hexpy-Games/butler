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
    let mut keys = std::collections::HashMap::new();
    let rows = data
        .get("logins")
        .and_then(serde_json::Value::as_array)
        .ok_or(ImportError::Format)?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let encoded = STANDARD
            .decode(
                row["encryptedUsername"]
                    .as_str()
                    .ok_or(ImportError::Format)?,
            )
            .map_err(|_| ImportError::Format)?;
        let id = (nss::key_id(&encoded)?, nss::key_size(&encoded)?);
        if !keys.contains_key(&id) {
            keys.insert(
                id.clone(),
                decrypt_key(&snapshot.path, primary, &id.0, id.1)?,
            );
        }
        let key = keys.get(&id).ok_or(ImportError::Format)?;
        let username = decrypt_login(
            row.get("encryptedUsername")
                .and_then(serde_json::Value::as_str),
            key,
        )?;
        let password = decrypt_login(
            row.get("encryptedPassword")
                .and_then(serde_json::Value::as_str),
            key,
        )?;
        result.push(Login {
            origin: row
                .get("hostname")
                .and_then(serde_json::Value::as_str)
                .ok_or(ImportError::Format)?
                .into(),
            username,
            password,
            modified_ms: ["timeLastUsed", "timePasswordChanged"]
                .iter()
                .filter_map(|field| row[*field].as_i64())
                .max()
                .filter(|t| *t > 0),
        });
    }
    Ok(result)
}

fn decrypt_key(
    path: &Path,
    primary: &SecretText,
    id: &[u8],
    size: usize,
) -> Result<Zeroizing<Vec<u8>>, ImportError> {
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
    let mut statement = db
        .prepare("SELECT a11 FROM nssPrivate WHERE a102=?1")
        .map_err(|e| sql_error(&e))?;
    let rows = statement
        .query_map([id], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|e| sql_error(&e))?;
    for encrypted in rows {
        let key = nss::pbe(
            &encrypted.map_err(|e| sql_error(&e))?,
            &global,
            primary.expose().as_bytes(),
        )?;
        if key.len() == size {
            return Ok(key);
        }
    }
    Err(ImportError::Format)
}

fn decrypt_login(encoded: Option<&str>, key: &[u8]) -> Result<SecretText, ImportError> {
    let encoded = STANDARD
        .decode(encoded.ok_or(ImportError::Format)?)
        .map_err(|_| ImportError::Format)?;
    let clear = nss::login(&encoded, key)?;
    let text = std::str::from_utf8(&clear).map_err(|_| ImportError::Format)?;
    Ok(SecretText::new(text.into()))
}
