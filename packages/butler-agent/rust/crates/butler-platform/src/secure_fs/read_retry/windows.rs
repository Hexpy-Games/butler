//! Distinguish a delete-pending entry from a denied read without changing it.
use std::{
    fs::{self, File},
    io,
    os::windows::fs::OpenOptionsExt,
    path::Path,
    time::Duration,
};

use super::super::replace_retry::{ACCESS_DENIED, SHARING_ERRORS};

const FILE_TRAVERSE: u32 = 0x20;
const ATTEMPTS: u32 = 20;
const BACKOFF: Duration = Duration::from_millis(50);
// BACKUP_SEMANTICS supports directories; OVERLAPPED avoids implicitly
// requesting SYNCHRONIZE, so the zero-access probe tests no file DACL rights.
const PROBE_FLAGS: u32 = 0x4200_0000;

pub(super) fn read(path: &Path) -> io::Result<Vec<u8>> {
    let mut attempt = 1;
    loop {
        match fs::read(path) {
            Err(error)
                if attempt < ATTEMPTS
                    && super::read_retry_allowed(error.raw_os_error(), || delete_pending(path)) =>
            {
                attempt += 1;
                std::thread::sleep(BACKOFF);
            }
            result => return result,
        }
    }
}

fn probe(path: &Path, access: u32) -> io::Result<File> {
    File::options()
        .read(true)
        .access_mode(access)
        .share_mode(7)
        .custom_flags(PROBE_FLAGS)
        .open(path)
}

pub(in crate::secure_fs) fn delete_pending(path: &Path) -> bool {
    // A file DACL denying even FullControl still permits a zero-access open;
    // a delete-pending entry refuses that open with ACCESS_DENIED as well.
    // Confirm parent traversal separately: a denied ancestor is not a replace.
    match probe(path, 0) {
        Err(error) if error.raw_os_error() == Some(ACCESS_DENIED) => {}
        // The old entry may already have disappeared or been replaced by the
        // time we probe. A normal read open verifies current read permission.
        _ => {
            return match File::open(path) {
                Ok(_) => true,
                Err(error) => {
                    error.kind() == io::ErrorKind::NotFound
                        || SHARING_ERRORS.contains(&error.raw_os_error().unwrap_or_default())
                }
            };
        }
    }
    let parent = path.parent().filter(|path| !path.as_os_str().is_empty());
    probe(parent.unwrap_or(Path::new(".")), FILE_TRAVERSE).is_ok()
}
