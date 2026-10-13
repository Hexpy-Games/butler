//! Throwaway Windows profile encrypted by the current user's DPAPI.
use std::path::Path;

/// Returns false on platforms whose native cipher is different.
pub fn chromium_password_fixture(root: &Path, password: &str) -> std::io::Result<bool> {
    #[cfg(windows)]
    {
        create(root, password)?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = (root, password);
        Ok(false)
    }
}

#[cfg(windows)]
fn create(root: &Path, password: &str) -> std::io::Result<()> {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde_json::json;
    let err = |_| std::io::Error::other("fixture encryption failed");
    let dir = root.join("Work");
    std::fs::create_dir_all(&dir)?;
    let key = [42_u8; 32];
    let blob = windows_dpapi::encrypt_data(&key, windows_dpapi::Scope::User, None).map_err(err)?;
    let mut protected = b"DPAPI".to_vec();
    protected.extend(blob);
    std::fs::write(
        root.join("Local State"),
        json!({
            "profile":{"info_cache":{"Work":{"name":"Work"}}},
            "os_crypt":{"encrypted_key":STANDARD.encode(protected)}
        })
        .to_string(),
    )?;
    let db = rusqlite::Connection::open(dir.join("Login Data"))
        .map_err(|_| std::io::Error::other("fixture database failed"))?;
    db.execute_batch("CREATE TABLE logins(origin_url TEXT,username_value TEXT,password_value BLOB,blacklisted_by_user INTEGER,date_last_used INTEGER)")
        .map_err(|_| std::io::Error::other("fixture schema failed"))?;
    let nonce = [7_u8; 12];
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .encrypt(Nonce::from_slice(&nonce), password.as_bytes())
        .map_err(|_| std::io::Error::other("fixture AES failed"))?;
    let mut value = b"v10".to_vec();
    value.extend(nonce);
    value.extend(ciphertext);
    let mut tampered = value.clone();
    *tampered.last_mut().unwrap() ^= 1;
    for encrypted in [
        value,
        b"v20app-bound".to_vec(),
        tampered,
        b"v10short".to_vec(),
    ] {
        db.execute("INSERT INTO logins VALUES('https://login.fixture-shop.test','fixture',?1,0,13300000000000000)", [encrypted])
            .map_err(|_| std::io::Error::other("fixture insert failed"))?;
    }
    Ok(())
}
