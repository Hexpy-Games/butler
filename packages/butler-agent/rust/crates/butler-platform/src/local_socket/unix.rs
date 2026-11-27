use std::{io, path::Path};

#[cfg(target_os = "macos")]
const MAX_PATH_BYTES: usize = 103;
#[cfg(not(target_os = "macos"))]
const MAX_PATH_BYTES: usize = 107;

pub(super) const PATH_LIMIT: Option<usize> = Some(MAX_PATH_BYTES);

/// A local socket listener.
pub type LocalListener = tokio::net::UnixListener;
/// An accepted local socket connection.
pub type LocalStream = tokio::net::UnixStream;

/// Bind a socket in a private directory, replacing only an existing socket.
pub(super) fn bind(path: &Path) -> io::Result<LocalListener> {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    if path.as_os_str().len() > MAX_PATH_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("remote_socket_path_too_long: {}", path.display()),
        ));
    }
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
pub(super) async fn accept(listener: &LocalListener) -> io::Result<LocalStream> {
    listener.accept().await.map(|(stream, _)| stream)
}

/// Connect to a local socket.
pub(super) async fn connect(path: &Path) -> io::Result<LocalStream> {
    LocalStream::connect(path).await
}

/// Whether only the owner has access to a socket or its directory.
pub(super) fn owner_only(path: &Path) -> io::Result<bool> {
    use std::os::unix::fs::PermissionsExt;
    // No group or other permission bits.
    Ok(std::fs::metadata(path)?
        .permissions()
        .mode()
        .trailing_zeros()
        >= 6)
}
