//! Chromium macOS Login Data and Safe Storage. Windows uses the guided CSV flow.
use super::{ImportError, LoginBatch, SafeStorageKeySource};
#[cfg(target_os = "macos")]
use super::{Login, Snapshot, sql_error};
use std::path::Path;
#[cfg(target_os = "macos")]
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
pub(super) fn passwords(
    browser: &str,
    dir: &Path,
    scratch: &Path,
    keys: &dyn SafeStorageKeySource,
) -> Result<LoginBatch, ImportError> {
    let source = dir.join("Login Data");
    if !source.try_exists().map_err(|e| super::io_error(&e))? {
        return Ok(LoginBatch::default());
    }
    let key = keys.key(browser)?;
    read_logins(&source, scratch, &key)
}
#[cfg(not(target_os = "macos"))]
pub(super) fn passwords(
    _browser: &str,
    _dir: &Path,
    _scratch: &Path,
    _keys: &dyn SafeStorageKeySource,
) -> Result<LoginBatch, ImportError> {
    Err(ImportError::CsvRequired)
}

#[cfg(target_os = "macos")]
fn read_logins(source: &Path, scratch: &Path, password: &[u8]) -> Result<LoginBatch, ImportError> {
    let snapshot = Snapshot::new(source, scratch)?;
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
        .to_owned()
    };
    let query = format!(
        "SELECT origin_url,username_value,password_value,max(coalesce({},0), coalesce({},0)) FROM logins WHERE blacklisted_by_user=0 ORDER BY rowid",
        time("date_last_used"),
        time("date_password_modified")
    );
    let mut statement = db.prepare(&query).map_err(|e| sql_error(&e))?;
    let mut rows = statement.query([]).map_err(|e| sql_error(&e))?;
    let mut key = Zeroizing::new([0_u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut *key);
    let mut batch = LoginBatch::default();
    while let Some(row) = rows.next().map_err(|e| sql_error(&e))? {
        match decrypt_row(row, &key) {
            Ok(Some(login)) => batch.logins.push(login),
            Ok(None) => {}
            Err(_) => batch.invalid += 1,
        }
    }
    Ok(batch)
}

#[cfg(target_os = "macos")]
fn decrypt_row(row: &rusqlite::Row<'_>, key: &[u8; 16]) -> Result<Option<Login>, ImportError> {
    use crate::secrets::SecretText;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    let encrypted = Zeroizing::new(row.get::<_, Vec<u8>>(2).map_err(|e| sql_error(&e))?);
    if encrypted.is_empty() {
        return Ok(None);
    }
    let cipher = encrypted
        .strip_prefix(b"v10")
        .ok_or(ImportError::CsvRequired)?;
    let decrypted = Zeroizing::new(
        cbc::Decryptor::<aes::Aes128>::new(key.into(), (&[b' '; 16]).into())
            .decrypt_padded_vec_mut::<Pkcs7>(cipher)
            .map_err(|_| ImportError::Format)?,
    );
    let password = std::str::from_utf8(&decrypted).map_err(|_| ImportError::Format)?;
    let chrome_time: Option<i64> = row.get(3).map_err(|e| sql_error(&e))?;
    Ok(Some(Login {
        origin: row.get(0).map_err(|e| sql_error(&e))?,
        username: SecretText::new(row.get(1).map_err(|e| sql_error(&e))?),
        password: SecretText::new(password.into()),
        modified_ms: chrome_time
            .filter(|t| *t > 0)
            .map(|t| t / 1000 - 11_644_473_600_000),
    }))
}
