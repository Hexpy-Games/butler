//! How this host's file-change notifications describe ordinary file operations.

/// Replacing an existing file by rename (`MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`) is reported as a removal of the destination on
/// Windows, though the name keeps resolving throughout. Other hosts report the
/// replacement as a rename or creation.
pub const REPLACE_REPORTED_AS_REMOVE: bool = cfg!(windows);

/// NTFS commits a directory's own timestamp after the write that changed it
/// and reports that as a bare modification of the directory, seconds later.
/// The entries themselves are reported on their own paths.
pub const DIRECTORY_TIMESTAMP_ECHO: bool = cfg!(windows);
