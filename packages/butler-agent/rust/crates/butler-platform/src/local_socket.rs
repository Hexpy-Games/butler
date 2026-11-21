//! Owner-only local socket listeners for remote service mode.

use std::{io, path::Path};

/// A local socket listener.
#[cfg(unix)]
pub type LocalListener = tokio::net::UnixListener;
/// An accepted local socket connection.
#[cfg(unix)]
pub type LocalStream = tokio::net::UnixStream;

/// Bind a socket in a private directory, replacing only an existing socket.
#[cfg(unix)]
pub fn bind(path: &Path) -> io::Result<LocalListener> {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    if let Some(parent) = path.parent() {
        crate::secure_fs::create_private_dir_all(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => fs::remove_file(path)?,
        Ok(_) => return Err(io::ErrorKind::AlreadyExists.into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = LocalListener::bind(path)?;
    fs::set_permissions(path, Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// Accept the next local socket connection.
#[cfg(unix)]
pub async fn accept(listener: &LocalListener) -> io::Result<LocalStream> {
    listener.accept().await.map(|(stream, _)| stream)
}

/// Connect to a local socket.
#[cfg(unix)]
pub async fn connect(path: &Path) -> io::Result<LocalStream> {
    LocalStream::connect(path).await
}

/// Whether only the owner has access to a socket or its directory.
#[cfg(unix)]
pub fn owner_only(path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    // No group or other permission bits.
    Ok(std::fs::metadata(path)?
        .permissions()
        .mode()
        .trailing_zeros()
        >= 6)
}

/// Local socket streams cannot be constructed on Windows.
#[cfg(windows)]
pub enum LocalStream {}

/// Local socket listeners cannot be constructed on Windows.
#[cfg(windows)]
pub struct LocalListener(());

/// Local sockets require Unix.
#[cfg(windows)]
pub fn bind(_path: &Path) -> io::Result<LocalListener> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "local sockets need Unix",
    ))
}

/// Local sockets require Unix.
#[cfg(windows)]
pub async fn connect(_path: &Path) -> io::Result<LocalStream> {
    std::future::ready(Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "local sockets need Unix",
    )))
    .await
}

/// Local sockets require Unix.
#[cfg(windows)]
pub fn owner_only(_path: &Path) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "local sockets need Unix",
    ))
}

/// Unreachable because no local socket listener can be constructed.
#[cfg(windows)]
pub async fn accept(_listener: &LocalListener) -> io::Result<LocalStream> {
    std::future::pending().await
}

#[cfg(windows)]
impl tokio::io::AsyncRead for LocalStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match *self {}
    }
}

#[cfg(windows)]
impl tokio::io::AsyncWrite for LocalStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        match *self {}
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match *self {}
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match *self {}
    }
}
