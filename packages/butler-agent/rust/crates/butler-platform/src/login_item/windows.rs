//! Windows: the per-user Run key. The value name is Electron's, so a cutover replaces its entry.
use std::path::Path;

use winsafe::{HKEY, RegistryValue, co};

use super::LoginItemError;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "com.squirrel.butler-app.Butler";

/// The executable a Run value launches: the quoted path, or the text up to the first space.
fn launched(value: &str) -> &str {
    let value = value.trim();
    match value.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or_default(),
        None => value.split(' ').next().unwrap_or_default(),
    }
}

/// Whether the Run value names `executable`.
pub(super) fn enabled(executable: &Path) -> bool {
    let value = HKEY::CURRENT_USER
        .RegOpenKeyEx(Some(RUN_KEY), co::REG_OPTION::NoValue, co::KEY::QUERY_VALUE)
        .and_then(|key| key.RegQueryValueEx(Some(VALUE_NAME)));
    match (value, executable.to_str()) {
        (Ok(RegistryValue::Sz(value) | RegistryValue::ExpandSz(value)), Some(executable)) => {
            launched(&value).eq_ignore_ascii_case(executable)
        }
        _ => false,
    }
}

/// Writes `"<exe>"`, or removes the value while it still names this executable.
pub(super) fn set(executable: &Path, open_at_login: bool) -> Result<(), LoginItemError> {
    let fail = |call: &str| LoginItemError::Failed(format!("{call} failed"));
    if open_at_login {
        let executable = executable.to_str().ok_or_else(|| fail("Run key path"))?;
        return HKEY::CURRENT_USER
            .RegSetKeyValue(
                Some(RUN_KEY),
                Some(VALUE_NAME),
                RegistryValue::Sz(format!("\"{executable}\"")),
            )
            .map_err(|_| fail("RegSetKeyValue"));
    }
    if !enabled(executable) {
        return Ok(());
    }
    HKEY::CURRENT_USER
        .RegOpenKeyEx(Some(RUN_KEY), co::REG_OPTION::NoValue, co::KEY::SET_VALUE)
        .and_then(|key| key.RegDeleteValue(Some(VALUE_NAME)))
        .map_err(|_| fail("RegDeleteValue"))
}
