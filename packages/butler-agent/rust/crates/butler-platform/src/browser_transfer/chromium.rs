//! Chromium macOS Login Data and Safe Storage. Windows uses the guided CSV flow.
use super::{ImportError, Login};
#[cfg(target_os = "macos")]
use super::{Snapshot, sql_error};
use std::path::Path;
#[cfg(target_os = "macos")]
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
fn storage_key(browser: &str) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    let (service, account) = match browser {
        "chrome" => ("Chrome Safe Storage", "Chrome"),
        "edge" => ("Microsoft Edge Safe Storage", "Microsoft Edge"),
        "brave" => ("Brave Safe Storage", "Brave"),
        "arc" => ("Arc Safe Storage", "Arc"),
        "whale" => ("Whale Safe Storage", "Whale"),
        "chromium" => ("Chromium Safe Storage", "Chromium"),
        _ => return Err(ImportError::CsvRequired),
    };
    #[cfg(feature = "test-support")]
    let fixture = std::env::var("BUTLER_BROWSER_IMPORT_TEST_SERVICE")
        .ok()
        .filter(|s| s.starts_with("com.hexpy.butler.e2e.import."));
    #[cfg(feature = "test-support")]
    let service = fixture.as_deref().unwrap_or(service);
    security_framework::passwords::get_generic_password(service, account)
        .map(Zeroizing::new)
        .map_err(|_| ImportError::Keychain)
}

#[cfg(target_os = "macos")]
pub(super) fn passwords(
    browser: &str,
    dir: &Path,
    scratch: &Path,
) -> Result<Vec<Login>, ImportError> {
    let source = dir.join("Login Data");
    if !source.try_exists().map_err(|e| super::io_error(&e))? {
        return Ok(Vec::new());
    }
    let key = storage_key(browser)?;
    read_logins(&source, scratch, &key)
}
#[cfg(not(target_os = "macos"))]
pub(super) fn passwords(
    _browser: &str,
    _dir: &Path,
    _scratch: &Path,
) -> Result<Vec<Login>, ImportError> {
    Err(ImportError::CsvRequired)
}

#[cfg(target_os = "macos")]
fn read_logins(source: &Path, scratch: &Path, password: &[u8]) -> Result<Vec<Login>, ImportError> {
    use crate::secrets::SecretText;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
    let snapshot = Snapshot::new(source, scratch)?;
    let db = rusqlite::Connection::open(&snapshot.path).map_err(|e| sql_error(&e))?;
    let mut statement = db.prepare("SELECT origin_url, username_value, password_value FROM logins WHERE blacklisted_by_user=0 ORDER BY rowid").map_err(|e| sql_error(&e))?;
    let mut rows = statement.query([]).map_err(|e| sql_error(&e))?;
    let mut key = Zeroizing::new([0_u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut *key);
    let mut logins = Vec::new();
    while let Some(row) = rows.next().map_err(|e| sql_error(&e))? {
        let encrypted = Zeroizing::new(row.get::<_, Vec<u8>>(2).map_err(|e| sql_error(&e))?);
        if encrypted.is_empty() {
            continue;
        }
        let cipher = encrypted
            .strip_prefix(b"v10")
            .ok_or(ImportError::CsvRequired)?;
        let decrypted = Zeroizing::new(
            cbc::Decryptor::<aes::Aes128>::new((&*key).into(), (&[b' '; 16]).into())
                .decrypt_padded_vec_mut::<Pkcs7>(cipher)
                .map_err(|_| ImportError::Format)?,
        );
        let password = std::str::from_utf8(&decrypted).map_err(|_| ImportError::Format)?;
        logins.push(Login {
            origin: row.get(0).map_err(|e| sql_error(&e))?,
            username: SecretText::new(row.get(1).map_err(|e| sql_error(&e))?),
            password: SecretText::new(password.into()),
        });
    }
    Ok(logins)
}
