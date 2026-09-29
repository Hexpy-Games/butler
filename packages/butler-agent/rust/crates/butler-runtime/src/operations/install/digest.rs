//! The digests a `butler.native-agent-install.v1` manifest records: the
//! executable's SHA-256 and the resource tree's.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

/// SHA-256 of a regular file's bytes, lowercase hex. A symbolic link is not
/// hashed.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a regular file",
        ));
    }
    let mut digest = Sha256::new();
    update_with_file(&mut digest, path)?;
    Ok(hex(&digest.finalize()))
}

/// SHA-256 of a directory tree: for every entry, sorted by name, a line
/// naming its kind (`d`, `f`, or `l` with the link target) and path, then
/// the bytes of a file. Symbolic links are recorded, never followed.
pub fn sha256_tree(root: &Path) -> io::Result<String> {
    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a directory",
        ));
    }
    let mut digest = Sha256::new();
    update_with_directory(&mut digest, root, "")?;
    Ok(hex(&digest.finalize()))
}

fn update_with_directory(digest: &mut Sha256, directory: &Path, relative: &str) -> io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 name"))?;
        let label = if relative.is_empty() {
            name.to_owned()
        } else {
            format!("{relative}/{name}")
        };
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            let target = fs::read_link(&path)?;
            let target = target
                .to_str()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "non-UTF-8 target"))?;
            digest.update(format!("l:{label}:{target}\n").as_bytes());
        } else if kind.is_dir() {
            digest.update(format!("d:{label}\n").as_bytes());
            update_with_directory(digest, &path, &label)?;
        } else if kind.is_file() {
            digest.update(format!("f:{label}\n").as_bytes());
            update_with_file(digest, &path)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported entry",
            ));
        }
    }
    Ok(())
}

fn update_with_file(digest: &mut Sha256, path: &Path) -> io::Result<()> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(());
        }
        digest.update(buffer.get(..read).unwrap_or_default());
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(64), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}
