//! Snapshot online backups. No source checkpoint, VACUUM, or raw DB copying.
use super::state::{self, CutoverState};
use butler_platform::{fs_space, secure_fs, sqlite};
use rusqlite::{
    OpenFlags,
    backup::{Backup, StepResult},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const DATABASES: [&str; 2] = [
    "agent-runtime/btcc.sqlite",
    "app-server/butler-client.sqlite",
];

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub files: Vec<BackupFile>,
}

/// Refuses newer epochs before the native store performs schema writes.
pub fn check_epoch(root: &Path) -> io::Result<()> {
    let path = root.join(DATABASES[0]);
    if !path.exists() {
        return Ok(());
    }
    reject_links(root, Path::new(DATABASES[0]))?;
    let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
    state::check_epoch(&db).map_err(error)
}

/// Before source observation/import. Existing completed backup is reusable only while
/// resuming this cutover; completed cutovers never do another backup at idle.
pub fn prepare(root: &Path) -> io::Result<CutoverState> {
    prepare_with_cancel(root, &|| false)
}

/// Cancellation leaves an incomplete directory for the next start to redo.
pub fn prepare_with_cancel(root: &Path, cancelled: &dyn Fn() -> bool) -> io::Result<CutoverState> {
    check_cancelled(cancelled)?;
    let btcc = root.join(DATABASES[0]);
    if btcc.exists() {
        reject_links(root, Path::new(DATABASES[0]))?;
        let db = sqlite::open_with_flags(&btcc, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
        state::check_epoch(&db).map_err(error)?;
        let exists = db
            .query_row(super::sql::HAS_MIGRATION, [], |r| r.get::<_, bool>(0))
            .map_err(error)?;
        if exists && state::status(&db).map_err(error)?.state == CutoverState::Done {
            return Ok(CutoverState::Done);
        }
    }
    // Called only after both native databases have opened.
    if !btcc.exists() {
        return Err(error("BTCC database is unavailable for backup"));
    }
    let folder = private_folder(root, "backups/work-model-cutover")?;
    if let Some(path) = completed(&folder)?
        .iter()
        .rev()
        .find(|path| valid_with_cancel(path, cancelled).unwrap_or(false))
    {
        retain(&folder, path)?;
        return Ok(CutoverState::Importing);
    }
    check_cancelled(cancelled)?;
    remove_partial_sets(&folder)?;
    let size = database_bytes(root)?;
    let needed = size.saturating_add(size.div_ceil(10));
    if fs_space::available_bytes(root)? < needed {
        return Ok(CutoverState::PostponedNoSpace);
    }
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.9fZ").to_string();
    let destination = folder.join(timestamp);
    secure_fs::create_private_dir(&destination)?;
    secure_fs::protect_folder(&destination).unwrap_or(Ok(()))?;
    let mut files = Vec::new();
    for relative in DATABASES {
        let source = root.join(relative);
        if !source.exists() {
            return Err(error("A native database is unavailable for backup"));
        }
        reject_links(root, Path::new(relative))?;
        let name = Path::new(relative)
            .file_name()
            .ok_or_else(|| error("database name"))?
            .to_string_lossy()
            .into_owned();
        let path = destination.join(&name);
        copy(&source, &path, cancelled)?;
        files.push(BackupFile {
            name,
            size: fs::metadata(&path)?.len(),
            sha256: hash(&path, cancelled)?,
        });
    }
    publish(&destination, &Manifest { files })?;
    // Never delete a previous complete set until the new manifest is durable.
    retain(&folder, &destination)?;
    Ok(CutoverState::Importing)
}

fn database_bytes(root: &Path) -> io::Result<u64> {
    DATABASES.iter().try_fold(0_u64, |total, name| {
        let path = root.join(name);
        let size = if path.exists() {
            reject_links(root, Path::new(name))?;
            let db =
                sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
            let pages: u64 = db
                .pragma_query_value(None, "page_count", |r| r.get(0))
                .map_err(error)?;
            let bytes: u64 = db
                .pragma_query_value(None, "page_size", |r| r.get(0))
                .map_err(error)?;
            pages.saturating_mul(bytes)
        } else {
            0
        };
        Ok::<_, io::Error>(total.saturating_add(size))
    })
}

fn private_folder(root: &Path, relative: &str) -> io::Result<PathBuf> {
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
fn reject_links(root: &Path, relative: &Path) -> io::Result<()> {
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
fn copy(source: &Path, path: &Path, cancelled: &dyn Fn() -> bool) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    secure_fs::owner_only(&mut options);
    drop(options.open(path)?);
    let source =
        sqlite::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
    source.execute_batch("BEGIN").map_err(error)?;
    let mut target = sqlite::open(path).map_err(error)?;
    // Deliberate deviation from the spec's page batches: a single read
    // transaction copies all pages. WAL writers continue; their WAL grows for
    // the copy duration. Repeated small steps restart from page 1 on commits,
    // causing unbounded target rewrites under steady chat.
    let backup = Backup::new(&source, &mut target).map_err(error)?;
    loop {
        check_cancelled(cancelled)?;
        match backup.step(-1).map_err(error)? {
            StepResult::Done => break,
            StepResult::More => return Err(error("incomplete all-pages SQLite backup")),
            StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(10)),
            _ => return Err(error("unexpected SQLite backup state")),
        }
    }
    drop(backup);
    target.close().map_err(|(_, e)| error(e))?;
    secure_fs::sync_path(path)
}
fn publish(path: &Path, manifest: &Manifest) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    secure_fs::owner_only(&mut options);
    let mut file = options.open(path.join("manifest.tmp"))?;
    file.write_all(&serde_json::to_vec(manifest).map_err(error)?)?;
    file.sync_all()?;
    fs::rename(path.join("manifest.tmp"), path.join("manifest.json"))?;
    secure_fs::sync_path(path)
}
fn completed(root: &Path) -> io::Result<Vec<PathBuf>> {
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
pub fn valid(path: &Path) -> io::Result<bool> {
    valid_with_cancel(path, &|| false)
}
fn valid_with_cancel(path: &Path, cancelled: &dyn Fn() -> bool) -> io::Result<bool> {
    let manifest: Manifest =
        serde_json::from_reader(secure_fs::open_read_no_follow(&path.join("manifest.json"))?)
            .map_err(error)?;
    if manifest.files.len() != DATABASES.len() {
        return Ok(false);
    }
    let mut names = std::collections::BTreeSet::new();
    for file in manifest.files {
        if !matches!(file.name.as_str(), "btcc.sqlite" | "butler-client.sqlite")
            || !names.insert(file.name.clone())
        {
            return Ok(false);
        }
        let target = path.join(file.name);
        if fs::metadata(&target)?.len() != file.size || hash(&target, cancelled)? != file.sha256 {
            return Ok(false);
        }
    }
    Ok(true)
}
fn hash(path: &Path, cancelled: &dyn Fn() -> bool) -> io::Result<String> {
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
fn error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

fn retain(folder: &Path, newest: &Path) -> io::Result<()> {
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

fn check_cancelled(cancelled: &dyn Fn() -> bool) -> io::Result<()> {
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
// user content. Reclaim crashed copies before measuring space for their retry.
fn remove_partial_sets(folder: &Path) -> io::Result<()> {
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
