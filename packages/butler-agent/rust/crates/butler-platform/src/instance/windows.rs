//! Host name and process start times are not implemented on Windows yet.

use std::io;

pub(super) fn host_name() -> io::Result<String> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "the host name is unsupported on this host",
    ))
}

pub(super) fn process_started_at_ms(_pid: u32) -> Option<i64> {
    None
}
