//! Test-only injection at the E2E executable's composition root. No keychain writes.
use butler_platform::{
    account_dirs::AccountDirs,
    browser_profiles::{AccessProbe, ProfileAccess, probe},
    browser_transfer::{ImportDependencies, ImportError, SafeStorageKeySource},
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use zeroize::Zeroizing;

struct FixtureKey;
impl SafeStorageKeySource for FixtureKey {
    fn key(&self, _browser: &str) -> Result<Zeroizing<Vec<u8>>, ImportError> {
        Ok(Zeroizing::new(b"fixture-safe-storage".to_vec()))
    }
}
struct FixtureAccess(Option<PathBuf>);
impl AccessProbe for FixtureAccess {
    fn probe(&self, path: &Path) -> ProfileAccess {
        if self
            .0
            .as_ref()
            .is_some_and(|denied| path.starts_with(denied))
        {
            ProfileAccess::PermissionDenied
        } else {
            probe(path)
        }
    }
}
/// Explicit E2E executable injection; production builds never link this helper.
pub fn dependencies() -> ImportDependencies {
    let account = std::env::var_os("BUTLER_BROWSER_PROFILES_HOME")
        .map(|home| AccountDirs::under(Path::new(&home)));
    ImportDependencies {
        profiles: butler_platform::browser_profiles::ProfileSource {
            account,
            access: Arc::new(FixtureAccess(
                std::env::var_os("BUTLER_BROWSER_IMPORT_DENIED_FIXTURE").map(PathBuf::from),
            )),
        },
        keys: Arc::new(FixtureKey),
    }
}
