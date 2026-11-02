//! Test-only: how this host's file system and change notifications behave
//! where E2E fixtures must tolerate it. Product code never branches on these.

/// Replacing an existing file by rename (`MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`) is reported as a removal of the destination on
/// Windows, though the name keeps resolving throughout. Other hosts report the
/// replacement as a rename or creation.
#[doc(hidden)]
pub const REPLACE_REPORTED_AS_REMOVE: bool = cfg!(windows);

/// NTFS commits a directory's own timestamp after the write that changed it
/// and reports that as a bare modification of the directory, seconds later.
/// The entries themselves are reported on their own paths.
#[doc(hidden)]
pub const DIRECTORY_TIMESTAMP_ECHO: bool = cfg!(windows);

/// Whether `error` is Windows `ERROR_LOCK_VIOLATION`: a read refused because
/// another process (a live SQLite database, for its WAL index) holds a
/// byte-range lock that Windows enforces against readers.
#[doc(hidden)]
pub fn is_byte_range_lock_conflict(error: &std::io::Error) -> bool {
    cfg!(windows) && error.raw_os_error() == Some(33)
}
