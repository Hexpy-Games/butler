use std::fmt::Write;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use tokio::sync::Mutex;

/// Pipe names hash the path, so any path length works.
pub(super) const PATH_LIMIT: Option<usize> = None;

/// An owner-only named pipe listener.
pub struct LocalListener {
    name: String,
    next: Mutex<(NamedPipeServer, bool)>,
}

/// A local named pipe connection.
pub enum LocalStream {
    /// The accepted server end of a pipe instance.
    Server(NamedPipeServer),
    /// The client end of a pipe instance.
    Client(NamedPipeClient),
}

fn pipe_name(path: &Path) -> io::Result<String> {
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let file = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let key = crate::secure_fs::canonicalize(parent)?
        .join(file)
        .to_string_lossy()
        .to_lowercase();
    let digest = Sha256::digest(key.as_bytes());
    let mut name = String::from(r"\\.\pipe\butler-");
    for byte in digest.iter().take(16) {
        write!(name, "{byte:02x}").map_err(io::Error::other)?;
    }
    Ok(name)
}

pub(super) fn bind(path: &Path) -> io::Result<LocalListener> {
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    crate::secure_fs::create_private_dir_all(parent)?;
    let name = pipe_name(path)?;
    let mut first = ServerOptions::new()
        .first_pipe_instance(true)
        .write_dac(true)
        .write_owner(true)
        .reject_remote_clients(true)
        .create(&name)
        .map_err(|error| {
            if error.raw_os_error() == Some(5) {
                io::ErrorKind::AlreadyExists.into()
            } else {
                error
            }
        })?;
    // Tokio creates with the default DACL, so secure the first instance and discard it.
    crate::secure_fs::protect_kernel_object(&mut first)?;
    let next = new_instance(&name)?;
    drop(first);
    Ok(LocalListener {
        name,
        next: Mutex::new((next, false)),
    })
}

fn new_instance(name: &str) -> io::Result<NamedPipeServer> {
    // Later instances share the secured pipe's DACL.
    ServerOptions::new()
        .reject_remote_clients(true)
        .create(name)
}

pub(super) async fn accept(listener: &LocalListener) -> io::Result<LocalStream> {
    let mut next = listener.next.lock().await;
    let (pipe, broken) = &mut *next;
    if *broken {
        *pipe = new_instance(&listener.name)?;
        *broken = false;
    }
    if let Err(error) = pipe.connect().await {
        match new_instance(&listener.name) {
            Ok(replacement) => *pipe = replacement,
            Err(_) => *broken = true,
        }
        return Err(error);
    }
    // Keep a secured handle alive even if creating the replacement fails.
    let replacement = new_instance(&listener.name)?;
    Ok(LocalStream::Server(std::mem::replace(pipe, replacement)))
}

pub(super) async fn connect(path: &Path) -> io::Result<LocalStream> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || open_owned(&path))
        .await
        .map_err(io::Error::other)?
        .map(LocalStream::Client)
}

fn open_owned(path: &Path) -> io::Result<NamedPipeClient> {
    let name = pipe_name(path)?;
    let started = Instant::now();
    let client = loop {
        match ClientOptions::new().open(&name) {
            Ok(client) => break client,
            Err(error)
                if error.raw_os_error() == Some(231)
                    && started.elapsed() < Duration::from_secs(2) =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error),
        }
    };
    if !crate::secure_fs::owned_by_current_user(&client)? {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(client)
}

pub(super) fn owner_only(_path: &Path) -> io::Result<bool> {
    Err(io::ErrorKind::Unsupported.into())
}

impl AsyncRead for LocalStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(inner) => Pin::new(inner).poll_read(cx, buf),
            Self::Client(inner) => Pin::new(inner).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for LocalStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Server(inner) => Pin::new(inner).poll_write(cx, buf),
            Self::Client(inner) => Pin::new(inner).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(inner) => Pin::new(inner).poll_flush(cx),
            Self::Client(inner) => Pin::new(inner).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(inner) => Pin::new(inner).poll_shutdown(cx),
            Self::Client(inner) => Pin::new(inner).poll_shutdown(cx),
        }
    }
}
