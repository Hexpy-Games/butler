use butler_platform::secure_fs;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
pub(super) fn private_folder(root: &Path, relative: &str) -> io::Result<PathBuf> {
    let mut path = root.to_owned();
    for component in Path::new(relative).components() {
        path.push(component);
        if path.exists() {
            if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                return Err(error("backup directory must not be a symlink"));
            }
            secure_fs::restrict_directory(&path).unwrap_or(Ok(()))?;
        } else {
            secure_fs::create_private_dir(&path)?;
        }
        secure_fs::protect_folder(&path).unwrap_or(Ok(()))?;
    }
    Ok(path)
}
pub(super) fn reject_links(root: &Path, relative: &Path) -> io::Result<()> {
    // Never open/close a live database outside SQLite: on POSIX, closing any
    // descriptor for its inode releases this process's SQLite advisory locks.
    let mut path = root.to_path_buf();
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(error("database path must stay below the data directory"));
        }
        path.push(component);
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(error("database path must not contain symlinks"));
        }
    }
    Ok(())
}
pub(super) fn publish(path: &Path, manifest: &super::Manifest) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    secure_fs::owner_only(&mut options);
    let mut file = options.open(path.join("manifest.tmp"))?;
    file.write_all(&serde_json::to_vec(manifest).map_err(error)?)?;
    file.sync_all()?;
    fs::rename(path.join("manifest.tmp"), path.join("manifest.json"))?;
    secure_fs::sync_path(path)
}
pub(super) fn completed(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && entry.path().join("manifest.json").is_file() {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}
pub(super) fn hash(path: &Path, cancelled: &dyn Fn() -> bool) -> io::Result<String> {
    let mut file = secure_fs::open_read_no_follow(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 65536].into_boxed_slice();
    loop {
        check_cancelled(cancelled)?;
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
pub(super) fn error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

pub(super) fn retain(folder: &Path, newest: &Path) -> io::Result<()> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let recognized = chrono::NaiveDateTime::parse_from_str(&name, "%Y%m%dT%H%M%S%.fZ").is_ok();
        if recognized && entry.file_type()?.is_dir() && entry.path() != newest {
            fs::remove_dir_all(entry.path())?;
        }
    }
    secure_fs::sync_path(folder)
}

pub(super) fn check_cancelled(cancelled: &dyn Fn() -> bool) -> io::Result<()> {
    if cancelled() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Work cutover stopped",
        ))
    } else {
        Ok(())
    }
}

// Only our timestamp-named directories are eligible, never symlinks or other
// user content. Reclaim crashed sets before writing their replacement.
pub(super) fn remove_partial_sets(folder: &Path) -> io::Result<()> {
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if chrono::NaiveDateTime::parse_from_str(&name, "%Y%m%dT%H%M%S%.fZ").is_ok()
            && entry.file_type()?.is_dir()
            && !entry.path().join("manifest.json").try_exists()?
        {
            fs::remove_dir_all(entry.path())?;
        }
    }
    secure_fs::sync_path(folder)
}
