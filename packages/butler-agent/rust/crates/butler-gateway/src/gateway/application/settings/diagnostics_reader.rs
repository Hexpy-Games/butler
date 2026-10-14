//! Fresh indexed preference reads through one process-owned read-only connection.
use std::{io, path::PathBuf, sync::Arc, thread::JoinHandle};

use butler_platform::sqlite;
use parking_lot::Mutex;
use rusqlite::OpenFlags;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

use super::{SETTINGS_KEY, read_json};

#[derive(Clone)]
pub struct DiagnosticsSettingsReader {
    inner: Arc<Inner>,
}

struct Inner {
    sender: Mutex<Option<mpsc::Sender<Request>>>,
    thread: AsyncMutex<ThreadState>,
}

struct ThreadState {
    handle: Option<JoinHandle<()>>,
    error: Option<String>,
}

enum Request {
    Read(oneshot::Sender<bool>),
    Close,
}

impl DiagnosticsSettingsReader {
    /// Opening is lazy: an absent App database is never created.
    pub fn new(path: PathBuf) -> io::Result<Self> {
        let (sender, receiver) = mpsc::channel(64);
        let thread = std::thread::Builder::new()
            .name("butler-diagnostic-settings".into())
            .spawn(move || serve(&path, receiver))?;
        Ok(Self {
            inner: Arc::new(Inner {
                sender: Mutex::new(Some(sender)),
                thread: AsyncMutex::new(ThreadState {
                    handle: Some(thread),
                    error: None,
                }),
            }),
        })
    }

    /// Every call queries committed settings; only the connection is reused.
    pub async fn enabled(&self) -> bool {
        let sender = self.inner.sender.lock().clone();
        let Some(sender) = sender else { return false };
        let (reply, result) = oneshot::channel();
        if sender.send(Request::Read(reply)).await.is_err() {
            return false;
        }
        result.await.unwrap_or(false)
    }

    /// Drain reads and close the connection on its owner thread before returning.
    pub async fn close(&self) -> io::Result<()> {
        let mut thread = self.inner.thread.lock().await;
        let sender = self.inner.sender.lock().take();
        if let Some(sender) = sender {
            let _sent = sender.send(Request::Close).await;
        }
        if let Some(handle) = thread.handle.take() {
            let joined = tokio::task::spawn_blocking(move || handle.join()).await;
            if !matches!(joined, Ok(Ok(()))) {
                thread.error = Some("Diagnostic settings reader failed to close".into());
            }
        }
        match &thread.error {
            Some(error) => Err(io::Error::other(error.clone())),
            None => Ok(()),
        }
    }
}

fn serve(path: &std::path::Path, mut receiver: mpsc::Receiver<Request>) {
    let mut connection = None;
    while let Some(request) = receiver.blocking_recv() {
        match request {
            Request::Read(reply) => {
                let _sent = reply.send(read(path, &mut connection));
            }
            Request::Close => break,
        }
    }
    // Connection teardown is also blocking I/O and stays on this thread.
    drop(connection);
}

fn read(path: &std::path::Path, connection: &mut Option<sqlite::Connection>) -> bool {
    if connection.is_none() {
        *connection = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok();
    }
    let Some(db) = connection else { return false };
    match read_json(db, SETTINGS_KEY) {
        Ok(settings) => {
            settings.and_then(|settings| {
                settings
                    .get("diagnostics_enabled")
                    .and_then(serde_json::Value::as_bool)
            }) == Some(true)
        }
        Err(_) => {
            // Retry an unavailable database on the next read, without caching a flag.
            *connection = None;
            false
        }
    }
}
