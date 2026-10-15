//! Running this process at background priority, so long CPU work (embedding a
//! memory backlog) yields to what the user is doing.

use std::io;

/// Lowers this process's scheduling priority for background work: nice 10 on
/// macOS and Linux, the below-normal priority class on Windows. The process
/// cannot raise it again, so only processes doing background work call this.
pub fn lower_current() -> io::Result<()> {
    lower()
}

#[cfg(unix)]
fn lower() -> io::Result<()> {
    rustix::process::setpriority_process(None, 10).map_err(io::Error::from)
}

#[cfg(windows)]
fn lower() -> io::Result<()> {
    winsafe::HPROCESS::GetCurrentProcess()
        .SetPriorityClass(winsafe::co::PRIORITY_CLASS::BELOW_NORMAL)
        .map_err(|error| {
            io::Error::from_raw_os_error(i32::from_ne_bytes(error.raw().to_ne_bytes()))
        })
}
