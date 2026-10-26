//! notifyd power events with explicit process-owned shutdown and reaping.
use crate::process_control;
use std::{
    process::Stdio,
    sync::{Mutex, OnceLock},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

struct Watcher {
    cancellation: CancellationToken,
    task: Mutex<Option<JoinHandle<()>>>,
}
static WATCHER: OnceLock<Watcher> = OnceLock::new();

pub(super) fn start() {
    WATCHER.get_or_init(|| {
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = watch(cancel).await {
                eprintln!("[system-wake] notifyutil stopped: {error}");
            }
        });
        Watcher {
            cancellation,
            task: Mutex::new(Some(task)),
        }
    });
}

pub(super) async fn close() {
    let Some(watcher) = WATCHER.get() else { return };
    watcher.cancellation.cancel();
    let task = watcher
        .task
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(task) = task {
        let _ = task.await;
    }
}

async fn watch(cancel: CancellationToken) -> std::io::Result<()> {
    let mut command = std::process::Command::new("/usr/bin/notifyutil");
    command
        .args(["-w", "com.apple.powermanagement.systempowerstate"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    process_control::hide_console(&mut command);
    process_control::isolate_group(&mut command);
    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()?;
    process_control::contain(&child)?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("missing stdout"))?;
    let mut lines = BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            () = cancel.cancelled() => { child.kill().await?; return Ok(()); },
            line = lines.next_line() => {
                if line?.is_none() { break; }
                super::emit();
            }
        }
    }
    let status = child.wait().await?;
    Err(std::io::Error::other(format!("exited {status}")))
}
