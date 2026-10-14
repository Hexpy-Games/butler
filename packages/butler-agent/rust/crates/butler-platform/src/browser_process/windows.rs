//! Two anonymous pipes whose browser ends are inheritable handles, named on
//! the command line by `--remote-debugging-io-pipes=<read>,<write>` (handle
//! values are the same in the child). This side keeps non-inheritable
//! duplicates only, so later children never inherit the DevTools pipe. The
//! browser runs in a Job Object that ends its whole tree when closed.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::path::Path;
use std::process::{Command, Stdio};

use filedescriptor::FileDescriptor;
use tokio::sync::mpsc;
use winsafe::{HPIPE, SECURITY_ATTRIBUTES};

use crate::process_control::{self, GroupSignal};

pub(super) const HEADLESS_SHELL_EXECUTABLE: &str = "chrome-headless-shell.exe";

/// The pid, the browser's output, its input, and the tree guard.
pub(super) type Spawned = (u32, mpsc::Receiver<Vec<u8>>, mpsc::Sender<Vec<u8>>, Guard);

pub(super) struct Guard {
    pid: u32,
}

impl Guard {
    pub(super) fn kill(&mut self) {
        let _ = process_control::signal_group(self.pid, GroupSignal::Kill);
    }
}

/// A borrowed pipe handle, for a non-inheritable duplicate.
struct Borrowed(RawHandle);

impl AsRawHandle for Borrowed {
    fn as_raw_handle(&self) -> RawHandle {
        self.0
    }
}

fn duplicate(handle: &HPIPE) -> io::Result<FileDescriptor> {
    FileDescriptor::dup(&Borrowed(handle.ptr())).map_err(io::Error::other)
}

pub(super) fn spawn(program: &Path, args: &[OsString], log: &Path) -> io::Result<Spawned> {
    let mut inheritable = SECURITY_ATTRIBUTES::default();
    inheritable.set_bInheritHandle(true);
    let (child_read, parent_write) =
        HPIPE::CreatePipe(Some(&inheritable), 0).map_err(io::Error::other)?;
    let (parent_read, child_write) =
        HPIPE::CreatePipe(Some(&inheritable), 0).map_err(io::Error::other)?;
    let mut writer = duplicate(&parent_write)?;
    let mut reader = duplicate(&parent_read)?;
    drop(parent_write);
    drop(parent_read);
    let pipes = format!(
        "--remote-debugging-io-pipes={},{}",
        child_read.ptr() as usize,
        child_write.ptr() as usize
    );
    let output = OpenOptions::new().create(true).append(true).open(log)?;
    let mut command = Command::new(program);
    command
        .args(args)
        .arg(pipes)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output.try_clone()?))
        .stderr(Stdio::from(output));
    process_control::isolate_group(&mut command);
    let mut child = command.spawn()?;
    drop(child_read);
    drop(child_write);
    if let Err(error) = process_control::contain_std(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    let (incoming_tx, incoming) = mpsc::channel::<Vec<u8>>(64);
    let (outgoing, mut outgoing_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if incoming_tx
                        .blocking_send(buffer.get(..read).unwrap_or_default().to_vec())
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        while let Some(bytes) = outgoing_rx.blocking_recv() {
            if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });
    Ok((pid, incoming, outgoing, Guard { pid }))
}
