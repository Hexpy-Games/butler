//! Minimal directory-only adaptation of notify 8.2.0's Windows backend.
#[cfg(feature = "test-support")]
mod fixtures;
mod native;
use std::{
    io,
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    thread,
    time::Duration,
};

/// Directory name events; rename halves are remove/add so moved trees are rescanned.
#[derive(Clone, Debug)]
pub enum Change {
    Added(PathBuf),
    Removed(PathBuf),
    Rescan,
    Lost,
}
/// Native filter and buffer configuration. Buffer allocation is DWORD aligned.
#[derive(Clone, Copy)]
pub struct Config {
    pub flags: u32,
    pub buffer_bytes: usize,
}
/// FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME.
pub const NAME_CHANGES: u32 = 3;
type Reply = mpsc::Sender<io::Result<Vec<Change>>>;
enum Request {
    Drain(Reply),
    Stop,
    #[cfg(feature = "test-support")]
    Exercise(String, mpsc::Sender<io::Result<()>>),
}

/// Owns and joins its dedicated drain thread. No raw handles escape the backend.
pub struct Watch {
    sender: mpsc::Sender<Request>,
    wake: native::Wake,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}
impl Watch {
    pub fn new(root: &Path, config: Config) -> io::Result<Self> {
        if config.buffer_bytes < 4096 || config.buffer_bytes > 1024 * 1024 || config.flags == 0 {
            return Err(io::Error::other("invalid directory watch configuration"));
        }
        let root = root.to_owned();
        let wake = native::Wake::new()?;
        let wake_id = wake.id();
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("directory ledger drain".into())
            .spawn(move || {
                let result = native::Reader::new(&root, config);
                let status = result
                    .as_ref()
                    .map(|_| ())
                    .map_err(|e| io::Error::other(e.to_string()));
                let _ = ready_tx.send(status);
                if let Ok(mut reader) = result {
                    run(&mut reader, wake_id, receiver);
                }
            })?;
        let watch = Self {
            sender,
            wake,
            thread: Mutex::new(Some(thread)),
        };
        ready_rx
            .recv()
            .map_err(|_| io::Error::other("directory watcher exited"))??;
        Ok(watch)
    }
    /// Drains kernel completions preceding this barrier, not just a userspace queue.
    pub fn drain(&self, timeout: Duration) -> io::Result<Vec<Change>> {
        let (tx, rx) = mpsc::channel();
        self.sender
            .send(Request::Drain(tx))
            .map_err(|_| io::Error::other("directory watcher lost"))?;
        self.wake.signal()?;
        rx.recv_timeout(timeout)
            .map_err(|_| io::Error::other("directory watcher barrier timed out"))?
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self.sender.send(Request::Stop);
        let _ = self.wake.signal();
        if let Ok(thread) = self.thread.get_mut()
            && let Some(thread) = thread.take()
        {
            let _ = thread.join();
        }
    }
}
fn run(reader: &mut native::Reader, wake: usize, receiver: mpsc::Receiver<Request>) {
    let mut pending = Vec::new();
    loop {
        if reader.wait(wake).is_err() {
            break;
        }
        if reader.drain(&mut pending).is_err() {
            pending.push(Change::Lost);
        }
        while let Ok(request) = receiver.try_recv() {
            match request {
                Request::Stop => return,
                #[cfg(feature = "test-support")]
                Request::Exercise(kind, reply) => {
                    let result = fixtures::exercise(reader, &kind, &mut pending);
                    let _ = reply.send(result);
                }
                Request::Drain(reply) => {
                    if reader.drain(&mut pending).is_err() {
                        pending.push(Change::Lost);
                    }
                    let _ = reply.send(Ok(std::mem::take(&mut pending)));
                }
            }
        }
        if !reader.alive() {
            return;
        }
    }
}

/// Whether the process window station is visible to an interactive user.
pub fn interactive_desktop() -> io::Result<bool> {
    native::interactive_desktop()
}

#[cfg(feature = "test-support")]
impl Watch {
    /// Drives real kernel completions deterministically in isolated fixture roots.
    pub fn exercise(&self, kind: &str) -> io::Result<()> {
        let (tx, rx) = mpsc::channel();
        self.sender
            .send(Request::Exercise(kind.to_owned(), tx))
            .map_err(|_| io::Error::other("watcher lost"))?;
        self.wake.signal()?;
        rx.recv().map_err(|_| io::Error::other("watcher lost"))?
    }
}
