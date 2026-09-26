//! Exact App project-source snapshot bytes; no live project or workspace lookup.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::{ContextError, ContextResult};

const MAX_SOURCE_BYTES: u64 = 10 * 1024 * 1024;

pub(super) fn read(
    data_root: &Path,
    file_id: &str,
    size_bytes: u64,
    sha256: &str,
) -> ContextResult<Vec<u8>> {
    if !valid_file_id(file_id) || size_bytes > MAX_SOURCE_BYTES {
        return Err(unavailable());
    }
    let path = data_root.join("app-server/message-files").join(file_id);
    let mut file = open_snapshot(&path).map_err(|_| unavailable())?;
    let metadata = file.metadata().map_err(|_| unavailable())?;
    if !metadata.is_file() || metadata.len() != size_bytes {
        return Err(unavailable());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(size_bytes).unwrap_or(usize::MAX));
    file.by_ref()
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() as u64 != size_bytes || format!("{:x}", Sha256::digest(&bytes)) != sha256 {
        return Err(ContextError::new(
            "source_snapshot_changed",
            "The admitted project source snapshot changed.",
        ));
    }
    Ok(bytes)
}

fn valid_file_id(value: &str) -> bool {
    value.strip_prefix("file-").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

#[cfg(unix)]
fn open_snapshot(path: &Path) -> std::io::Result<File> {
    use rustix::fs::{Mode, OFlags, open};

    open(path, OFlags::RDONLY | OFlags::NOFOLLOW, Mode::empty())
        .map(File::from)
        .map_err(std::io::Error::from)
}

#[cfg(not(unix))]
fn open_snapshot(path: &Path) -> std::io::Result<File> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("snapshot link is unavailable"));
    }
    File::open(path)
}

fn unavailable() -> ContextError {
    ContextError::new("source_unavailable", "Project source snapshot unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admitted_snapshot_digest_and_nofollow_are_enforced() {
        let root =
            std::env::temp_dir().join(format!("butler-project-source-{}", uuid::Uuid::new_v4()));
        let files = root.join("app-server/message-files");
        std::fs::create_dir_all(&files).unwrap();
        let id = "file-fixture";
        let path = files.join(id);
        std::fs::write(&path, "accepted").unwrap();
        let digest = format!("{:x}", Sha256::digest(b"accepted"));
        assert_eq!(read(&root, id, 8, &digest).unwrap(), b"accepted");
        std::fs::write(&path, "replaced").unwrap();
        assert_eq!(
            read(&root, id, 8, &digest).unwrap_err().code,
            "source_snapshot_changed"
        );
        #[cfg(unix)]
        {
            std::fs::remove_file(&path).unwrap();
            std::fs::write(root.join("outside"), "accepted").unwrap();
            std::os::unix::fs::symlink(root.join("outside"), &path).unwrap();
            assert_eq!(
                read(&root, id, 8, &digest).unwrap_err().code,
                "source_unavailable"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
