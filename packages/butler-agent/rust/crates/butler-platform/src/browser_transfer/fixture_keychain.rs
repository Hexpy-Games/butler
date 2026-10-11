//! A disposable Safe Storage fixture trusts only its two test executables.
use std::io;
use std::path::Path;

/// Creates a test-namespaced item, without putting the fixture secret in argv.
pub fn fixture_safe_storage(service: &str, agent: &Path) -> io::Result<()> {
    if !service.starts_with("com.hexpy.butler.e2e.import.")
        || !service
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    {
        return Err(io::Error::other("invalid fixture service"));
    }
    create(service, agent)
}

#[cfg(target_os = "macos")]
fn create(service: &str, agent: &Path) -> io::Result<()> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let quote = |path: &Path| -> io::Result<String> {
        let path = path.canonicalize()?;
        let text = path.to_string_lossy();
        if text.contains(['\n', '\r', '\0']) {
            return Err(io::Error::other("invalid fixture executable"));
        }
        Ok(format!(
            "\"{}\"",
            text.replace('\\', "\\\\").replace('"', "\\\"")
        ))
    };
    let input = format!(
        "add-generic-password -s {service} -a Chrome -T {} -T {} -w fixture-safe-storage\n",
        quote(agent)?,
        quote(&std::env::current_exe()?)?
    );
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let written = child.stdin.take().map_or_else(
        || Err(io::Error::other("fixture stdin")),
        |mut stdin| stdin.write_all(input.as_bytes()),
    );
    let status = child.wait()?;
    written?;
    if !status.success() {
        return Err(io::Error::other("fixture keychain creation failed"));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn create(service: &str, _agent: &Path) -> io::Result<()> {
    use crate::secrets::{SecretKey, SecretStore};
    let key =
        SecretKey::new(service, "Chrome").map_err(|_| io::Error::other("invalid fixture key"))?;
    SecretStore::system()
        .and_then(|store| store.set(&key, "fixture-safe-storage"))
        .map_err(|_| io::Error::other("fixture keychain creation failed"))
}
