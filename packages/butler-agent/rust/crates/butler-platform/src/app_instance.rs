//! One App per data folder (Electron `requestSingleInstanceLock`, `main.mjs:432-466`): the first
//! launch owns a local endpoint for the folder; a later launch hands it its arguments and exits.
//!
//! The endpoint is a FIFO in the data folder, under the folder's App lock, on macOS and Linux,
//! and a named pipe named after the folder on Windows. The owner only reacts: one thread
//! waits in the OS for a message; nothing polls or writes on its own.

use std::io;
use std::path::Path;
use std::time::Duration;

use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// The most a launch hands over (its arguments as JSON).
const LIMIT: u64 = 64 * 1024;
/// A later launch's tries to reach the owner (which opens its endpoint right after it takes the
/// folder) or, when the owner is gone by then, to take the folder itself.
const TRIES: u32 = 50;
const PAUSE: Duration = Duration::from_millis(20);

/// What this launch is for its data folder.
pub enum Launch {
    /// The App of the folder; later launches' arguments arrive here.
    First(UnboundedReceiver<Vec<String>>),
    /// Another App owns the folder; exit. It has this launch's arguments unless it could not be
    /// reached (Electron quits either way, `main.mjs:440-446`).
    Forwarded,
}

/// Takes the data folder for this launch, or hands `args` to the App that has it.
///
/// Call it from a thread that runs no async task (it owns a Tokio runtime while it runs).
///
/// # Errors
/// The endpoint could not be opened: nothing says whether another App has the folder.
pub fn claim(data: &Path, args: &[String]) -> io::Result<Launch> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()?;
    let mut message = serde_json::to_vec(args).map_err(io::Error::other)?;
    message.push(b'\n');
    for _ in 0..TRIES {
        let owned = {
            let _context = runtime.enter();
            sys::own(data)?
        };
        if let Some(endpoint) = owned {
            return listen(runtime, endpoint).map(Launch::First);
        }
        if sys::send(data, &message).is_ok() {
            return Ok(Launch::Forwarded);
        }
        std::thread::sleep(PAUSE);
    }
    Ok(Launch::Forwarded)
}

/// One thread that waits in the OS and sends each later launch's arguments, until the
/// receiver is dropped.
fn listen(
    runtime: tokio::runtime::Runtime,
    mut endpoint: sys::Endpoint,
) -> io::Result<UnboundedReceiver<Vec<String>>> {
    let (launches, handed) = unbounded_channel();
    std::thread::Builder::new()
        .name("butler-app-instance".into())
        .spawn(move || {
            runtime.block_on(async move {
                while let Ok(message) = endpoint.next().await {
                    if let Ok(args) = serde_json::from_slice::<Vec<String>>(&message)
                        && launches.send(args).is_err()
                    {
                        return;
                    }
                }
            });
        })?;
    Ok(handed)
}
