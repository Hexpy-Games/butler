//! Descriptors 3 and 4 through `/bin/sh`: `exec` duplicates the piped stdin
//! and stdout onto them, then points stdin at `/dev/null` and stdout at the log.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::process::Stdio;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::process_control::{self, GroupSignal};

pub(super) const HEADLESS_SHELL_EXECUTABLE: &str = "chrome-headless-shell";

/// `$1` is the log, the rest is the browser's argv. Positional parameters
/// keep every path and switch literal (no quoting or word splitting).
const SHIM: &str = r#"log=$1; shift; exec "$@" 3<&0 4>&1 0</dev/null 1>>"$log" 2>&1"#;

/// The pid, the browser's output, its input, and the tree guard.
pub(super) type Spawned = (u32, mpsc::Receiver<Vec<u8>>, mpsc::Sender<Vec<u8>>, Guard);

pub(super) struct Guard {
    pid: u32,
    child: Option<tokio::process::Child>,
}

impl Guard {
    pub(super) fn kill(&mut self) {
        let _ = process_control::signal_group(self.pid, GroupSignal::Kill);
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            // Reap the leader so no zombie outlives the handle.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                drop(runtime.spawn(async move {
                    let _ = child.wait().await;
                }));
            }
        }
    }
}

pub(super) fn spawn(program: &Path, args: &[OsString], log: &Path) -> io::Result<Spawned> {
    let errors = OpenOptions::new().create(true).append(true).open(log)?;
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(SHIM)
        .arg("butler-browser")
        .arg(log)
        .arg(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(errors))
        .kill_on_drop(true)
        .process_group(0);
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("browser exited at start"))?;
    let (Some(mut writer), Some(mut reader)) = (child.stdin.take(), child.stdout.take()) else {
        return Err(io::Error::other("browser pipes unavailable"));
    };
    let (incoming_tx, incoming) = mpsc::channel::<Vec<u8>>(64);
    let (outgoing, mut outgoing_rx) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if incoming_tx
                        .send(buffer.get(..read).unwrap_or_default().to_vec())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    tokio::spawn(async move {
        while let Some(bytes) = outgoing_rx.recv().await {
            if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                break;
            }
        }
    });
    Ok((
        pid,
        incoming,
        outgoing,
        Guard {
            pid,
            child: Some(child),
        },
    ))
}
