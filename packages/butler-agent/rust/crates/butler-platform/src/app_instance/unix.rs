//! The folder's App lock (`flock`) and a FIFO beside it; a launch writes one line.
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use crate::instance::{InstanceLock, LockError};
use crate::secure_fs;

pub(super) struct Endpoint {
    lines: tokio::io::BufReader<tokio::net::unix::pipe::Receiver>,
    /// The owner's own writing end: the FIFO never reports end of file between launches.
    _open: tokio::net::unix::pipe::Sender,
    _lock: InstanceLock,
}

fn runtime_dir(data: &Path) -> PathBuf {
    data.join("app").join("runtime")
}

fn fifo(data: &Path) -> PathBuf {
    runtime_dir(data).join("app-instance.fifo")
}

/// The endpoint when no other App holds the folder's lock. Call inside a Tokio runtime.
pub(super) fn own(data: &Path) -> io::Result<Option<Endpoint>> {
    let dir = runtime_dir(data);
    secure_fs::create_private_dir_all(&dir)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).write(true);
    secure_fs::owner_only(&mut options);
    let lock = match InstanceLock::try_exclusive(options.open(dir.join("app-instance.lock"))?) {
        Ok(lock) => lock,
        Err(LockError::Busy) => return Ok(None),
        Err(LockError::Failed(error)) => return Err(error),
    };
    let fifo = fifo(data);
    match nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)) {
        Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
        Err(errno) => return Err(errno.into()),
    }
    let receiver = tokio::net::unix::pipe::OpenOptions::new().open_receiver(&fifo)?;
    let open = tokio::net::unix::pipe::OpenOptions::new().open_sender(&fifo)?;
    Ok(Some(Endpoint {
        lines: tokio::io::BufReader::new(receiver),
        _open: open,
        _lock: lock,
    }))
}

impl Endpoint {
    /// One launch's line.
    pub(super) async fn next(&mut self) -> io::Result<Vec<u8>> {
        use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _};
        let mut line = Vec::new();
        if (&mut self.lines)
            .take(super::LIMIT)
            .read_until(b'\n', &mut line)
            .await?
            == 0
        {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        Ok(line)
    }
}

/// Fails at once when no App has the FIFO open.
pub(super) fn send(data: &Path, message: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(nix::fcntl::OFlag::O_NONBLOCK.bits())
        .open(fifo(data))?
        .write_all(message)
}
