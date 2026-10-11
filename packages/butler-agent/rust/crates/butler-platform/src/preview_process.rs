//! Contained long-lived dev servers with one bounded stdout/stderr ring.
use crate::{
    command_sandbox,
    process_control::{self, GroupSignal},
};
use std::{
    collections::{HashMap, VecDeque},
    io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::watch,
};
use tokio_util::sync::CancellationToken;

/// Combined log tail capacity, in bytes.
pub const LOG_CAPACITY: usize = 64 * 1024;
/// Owns a server tree. Dropping the handle requests tree termination.
pub struct PreviewProcess {
    pid: u32,
    log: Arc<Mutex<VecDeque<u8>>>,
    cancel: CancellationToken,
    running: watch::Receiver<bool>,
}
impl PreviewProcess {
    /// Start exactly the reviewed shell command in the reviewed directory.
    pub async fn start(command: String, cwd: PathBuf) -> io::Result<Self> {
        let command = tokio::task::spawn_blocking(move || prepare(&command, &cwd))
            .await
            .map_err(io::Error::other)??;
        let mut child = tokio::process::Command::from(command)
            .kill_on_drop(true)
            .spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("Missing process id"))?;
        let tree = Tree(pid);
        if let Err(error) = process_control::contain(&child) {
            let _ = child.kill().await;
            return Err(error);
        }
        let log = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_CAPACITY)));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Missing stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("Missing stderr"))?;
        let out = tokio::spawn(drain(stdout, log.clone()));
        let err = tokio::spawn(drain(stderr, log.clone()));
        let cancel = CancellationToken::new();
        let stopped = cancel.clone();
        let (send, running) = watch::channel(true);
        tokio::spawn(async move {
            tokio::select! {
                _ = child.wait() => {},
                () = stopped.cancelled() => {},
            }
            stopped.cancel();
            drop(tree); // Includes descendants after a launcher exits.
            let _ = child.wait().await;
            out.abort();
            err.abort();
            let _ = send.send(false);
        });
        Ok(Self {
            pid,
            log,
            cancel,
            running,
        })
    }
    /// Process id of the containment leader.
    pub fn pid(&self) -> u32 {
        self.pid
    }
    /// Whether the containment supervisor has finished.
    pub fn is_running(&self) -> bool {
        *self.running.borrow()
    }
    /// Signal shared by proxy connections and the tree owner.
    pub fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }
    /// A bounded snapshot. Invalid partial UTF-8 at the ring boundary is replaced.
    pub fn log(&self) -> String {
        let bytes: Vec<_> = self
            .log
            .lock()
            .map(|log| log.iter().copied().collect())
            .unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        let mut start = text.len().saturating_sub(LOG_CAPACITY);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text.get(start..).unwrap_or_default().to_owned()
    }
    /// Resolve after tree termination and child reaping.
    pub async fn stop(mut self) {
        self.cancel.cancel();
        while *self.running.borrow_and_update() {
            if self.running.changed().await.is_err() {
                break;
            }
        }
    }
}
impl Drop for PreviewProcess {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
struct Tree(u32);
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = process_control::signal_group(self.0, GroupSignal::Kill);
    }
}
fn prepare(text: &str, cwd: &Path) -> io::Result<std::process::Command> {
    let environment =
        command_sandbox::tool_environment(&std::env::vars().collect::<HashMap<_, _>>());
    let invocation =
        command_sandbox::login_shell(text, command_sandbox::ShellAccess::Full, &environment)
            .map_err(io::Error::other)?;
    let mut command = std::process::Command::new(&invocation.program);
    command_sandbox::add_arguments(&mut command, &invocation);
    command
        .current_dir(command_sandbox::working_directory(cwd)?)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_control::hide_console(&mut command);
    if process_control::isolate_group(&mut command).is_none() {
        return Err(io::Error::other("Process containment unavailable"));
    }
    Ok(command)
}
async fn drain(mut stream: impl AsyncRead + Unpin, log: Arc<Mutex<VecDeque<u8>>>) {
    let mut bytes = [0; 4096];
    while let Ok(n) = stream.read(&mut bytes).await {
        if n == 0 {
            break;
        }
        if let Ok(mut ring) = log.lock() {
            let excess = (ring.len() + n).saturating_sub(LOG_CAPACITY);
            ring.drain(..excess);
            ring.extend(bytes.iter().take(n));
        }
    }
}
