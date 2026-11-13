//! Device-bound secrets using systemd's per-user credential encryption.
use super::SecretText;
use std::io;

/// Whether this user can seal secrets with systemd's per-user credential encryption.
pub fn sealed_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *AVAILABLE.get_or_init(|| {
            let probe = SecretText::new("butler credential probe".to_owned());
            seal_secret("butler-probe", &probe)
                .and_then(|sealed| unseal_secret("butler-probe", &sealed))
                .is_ok_and(|opened| opened.expose() == probe.expose())
        })
    }
    #[cfg(not(target_os = "linux"))]
    false
}

/// The secret sealed under `name` for this user on this machine.
pub fn seal_secret(name: &str, secret: &SecretText) -> io::Result<Vec<u8>> {
    credentials("encrypt", name, secret.expose().as_bytes())
}

/// Opens the secret sealed under `name` for this user on this machine.
pub fn unseal_secret(name: &str, sealed: &[u8]) -> io::Result<SecretText> {
    let opened = credentials("decrypt", name, sealed)?;
    String::from_utf8(opened)
        .map(SecretText::new)
        .map_err(|_| io::Error::other("systemd-creds failed"))
}

#[cfg(target_os = "linux")]
fn credentials(operation: &str, name: &str, input: &[u8]) -> io::Result<Vec<u8>> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("systemd-creds")
        .arg("--user")
        .arg(format!("--name={name}"))
        .args([operation, "-", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let written = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("systemd-creds failed"))?
        .write_all(input);
    let output = child.wait_with_output()?;
    if !output.status.success() {
        return Err(io::Error::other("systemd-creds failed"));
    }
    written?;
    Ok(output.stdout)
}

#[cfg(not(target_os = "linux"))]
fn credentials(_: &str, _: &str, _: &[u8]) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "systemd credentials are unavailable",
    ))
}
