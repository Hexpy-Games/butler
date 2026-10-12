//! Source access and decryption dependencies, owned by the host composition root.
use super::ImportError;
use crate::browser_profiles::ProfileSource;
use std::sync::Arc;
use zeroize::Zeroizing;

/// Reads the source browser's Safe Storage key without modifying its keychain.
pub trait SafeStorageKeySource: Send + Sync {
    /// Source key, wiped on drop.
    fn key(&self, browser: &str) -> Result<Zeroizing<Vec<u8>>, ImportError>;
}
/// System source keychain, read only.
pub struct SystemSafeStorage;
impl SafeStorageKeySource for SystemSafeStorage {
    fn key(&self, browser: &str) -> Result<Zeroizing<Vec<u8>>, ImportError> {
        storage_key(browser)
    }
}

/// Dependencies supplied when starting the gateway.
#[derive(Clone)]
pub struct ImportDependencies {
    /// Native or explicitly supplied account folders and access probe.
    pub profiles: ProfileSource,
    /// Source decryption key.
    pub keys: Arc<dyn SafeStorageKeySource>,
}
impl Default for ImportDependencies {
    fn default() -> Self {
        Self {
            profiles: ProfileSource::default(),
            keys: Arc::new(SystemSafeStorage),
        }
    }
}
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
    security_framework::passwords::get_generic_password(service, account)
        .map(Zeroizing::new)
        .map_err(|_| ImportError::Keychain)
}

#[cfg(not(target_os = "macos"))]
fn storage_key(_browser: &str) -> Result<Zeroizing<Vec<u8>>, ImportError> {
    Err(ImportError::CsvRequired)
}
