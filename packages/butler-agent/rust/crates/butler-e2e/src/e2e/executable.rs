//! Publish runnable fixtures only after their writable handle is closed.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Output};
use std::time::Duration;

const RETRY_DELAYS_MS: [u64; 4] = [10, 20, 40, 80];

fn publish(
    path: &Path,
    write: impl FnOnce(&mut fs::File, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let name = format!(".e2e-{}", uuid::Uuid::new_v4());
    let staging = path.with_file_name(name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        write(&mut file, &staging)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&staging, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

/// Copies an executable without ever opening its published inode for writing.
pub fn copy(source: &Path, path: &Path) -> io::Result<()> {
    publish(path, |file, _| {
        io::copy(&mut fs::File::open(source)?, file)?;
        file.set_permissions(fs::metadata(source)?.permissions())
    })
}

/// Writes a runnable script and sets its mode before publishing it.
pub fn write_script(path: &Path, contents: &str) -> io::Result<()> {
    publish(path, |file, staging| {
        file.write_all(contents.as_bytes())?;
        butler_platform::launcher::mark_executable(staging).unwrap_or(Ok(()))
    })
}

/// Retries only Linux's transient executable-busy spawn failure.
pub fn retry<T>(mut operation: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    for delay in RETRY_DELAYS_MS {
        match operation() {
            Err(error) if butler_platform::process_control::is_executable_busy(&error) => {
                std::thread::sleep(Duration::from_millis(delay));
            }
            result => return result,
        }
    }
    operation()
}

pub fn spawn(command: &mut Command) -> io::Result<Child> {
    retry(|| command.spawn())
}

pub fn output(command: &mut Command) -> io::Result<Output> {
    retry(|| command.output())
}

pub fn status(command: &mut Command) -> io::Result<ExitStatus> {
    retry(|| command.status())
}

pub async fn spawn_async(
    command: &mut tokio::process::Command,
) -> io::Result<tokio::process::Child> {
    let mut delay = 10;
    loop {
        match command.spawn() {
            Err(error)
                if butler_platform::process_control::is_executable_busy(&error) && delay <= 80 =>
            {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                delay *= 2;
            }
            result => return result,
        }
    }
}
