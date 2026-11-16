//! A named pipe named after the folder; its first instance is the folder's App lock.
use std::io::{self, Write as _};
use std::path::Path;

use sha2::{Digest as _, Sha256};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

pub(super) struct Endpoint {
    name: String,
    server: NamedPipeServer,
}

/// The pipe of a data folder: its absolute path, which does not change once the folder exists.
fn name(data: &Path) -> String {
    let path = std::path::absolute(data).unwrap_or_else(|_| data.to_path_buf());
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    let mut name = String::from(r"\\.\pipe\butler-app-");
    for byte in digest.iter().take(16) {
        use std::fmt::Write;
        let _ = write!(name, "{byte:02x}");
    }
    name
}

/// The endpoint when no other App has the folder's pipe. Call inside a Tokio runtime.
pub(super) fn own(data: &Path) -> io::Result<Option<Endpoint>> {
    let name = name(data);
    match ServerOptions::new().first_pipe_instance(true).create(&name) {
        Ok(server) => Ok(Some(Endpoint { name, server })),
        // The pipe exists: another App created its first instance.
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(None),
        Err(error) => Err(error),
    }
}

impl Endpoint {
    /// One launch's message; the next pipe instance is created first, so the pipe never disappears.
    pub(super) async fn next(&mut self) -> io::Result<Vec<u8>> {
        use tokio::io::AsyncReadExt as _;
        self.server.connect().await?;
        let next = ServerOptions::new().create(&self.name)?;
        let connected = std::mem::replace(&mut self.server, next);
        let mut message = Vec::new();
        // A closed pipe ends the message as an end of file does.
        let _ = connected.take(super::LIMIT).read_to_end(&mut message).await;
        Ok(message)
    }
}

/// `SECURITY_IDENTIFICATION`: the pipe's server may identify this launch's user, not act as it.
const IDENTIFICATION: u32 = 0x0001_0000;

pub(super) fn send(data: &Path, message: &[u8]) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .write(true)
        .security_qos_flags(IDENTIFICATION)
        .open(name(data))?
        .write_all(message)
}
