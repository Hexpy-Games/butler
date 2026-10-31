//! Scenarios for `butler-vault`, which the product does not call yet, so they
//! drive its public API directly. Restarts and crashes go through the
//! `e2e-vault` companion process. Run with `BUTLER_E2E_TIER=stub`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "E2E assertions"
)]

#[path = "vault/file.rs"]
mod file;
#[path = "vault/merge.rs"]
mod merge;
#[path = "vault/transfer.rs"]
mod transfer;
#[path = "vault/unlock.rs"]
mod unlock;

use age::secrecy::SecretString;
use butler_platform::secrets::SecretText;
use butler_vault::vault::{ItemKind, NewItem, Vault, VaultPaths};
use std::path::{Path, PathBuf};

type Outcome = Result<(), Box<dyn std::error::Error>>;

const PASSWORD: &str = "correct horse battery staple";

fn password() -> SecretText {
    secret(PASSWORD)
}

fn secret(text: &str) -> SecretText {
    SecretText::new(text.to_owned())
}

fn item(id: &str, value: &str) -> NewItem {
    NewItem {
        id: id.to_owned(),
        kind: ItemKind::Signin,
        value: secret(value),
    }
}

/// A folder under the run's temporary directory, removed afterwards.
struct Folder(PathBuf);

impl Folder {
    fn new() -> Result<Self, std::io::Error> {
        let path = std::env::temp_dir().join(format!("vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A new vault opened by the master password, in its own folder.
struct Fixture {
    folder: Folder,
    paths: VaultPaths,
    vault: Vault,
}

impl Fixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let folder = Folder::new()?;
        let paths = VaultPaths::in_folder(&folder.path().join("auth"));
        let vault = Vault::new(paths.clone());
        vault.create_with_password(&password())?;
        Ok(Self {
            folder,
            paths,
            vault,
        })
    }

    /// The same files in a second handle, as another process would see them.
    fn second_handle(&self) -> Result<Vault, Box<dyn std::error::Error>> {
        let vault = Vault::new(self.paths.clone());
        vault.unlock_with_password(&password())?;
        Ok(vault)
    }

    /// The device identity, opened with nothing but standard age.
    fn identity(&self) -> Result<age::x25519::Identity, Box<dyn std::error::Error>> {
        let text = open_with_password(PASSWORD, &std::fs::read(self.paths.key_file())?)?;
        Ok(String::from_utf8(text)?.trim().parse()?)
    }
}

/// A password-protected file opened with nothing but standard age.
fn open_with_password(
    password: &str,
    sealed: &[u8],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let identity = age::scrypt::Identity::new(SecretString::from(password.to_owned()));
    Ok(age::decrypt(&identity, sealed)?)
}

/// Every file under `root`, with its contents.
fn files_under(root: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, std::io::Error> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let contents = std::fs::read(&path)?;
                found.push((path, contents));
            }
        }
    }
    found.sort();
    Ok(found)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|part| part == needle)
}
