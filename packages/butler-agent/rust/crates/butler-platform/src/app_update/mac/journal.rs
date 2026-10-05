//! One atomic exchange, preceded by a durable intent. Identity resolves a crash
//! between exchange and receipt without guessing from a version or pathname.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Journal {
    schema: u8,
    candidate: PathBuf,
    old: [u64; 2],
    new: [u64; 2],
}
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

fn journal(bundle: &Path) -> PathBuf {
    bundle.with_extension("app.update.json")
}

pub(super) fn pending(bundle: &Path) -> bool {
    journal(bundle).exists()
}

fn identity(path: &Path) -> Result<[u64; 2], String> {
    let m = fs::symlink_metadata(path).map_err(error)?;
    if !m.is_dir() {
        return Err("Update bundle must be a directory".into());
    }
    Ok([m.dev(), m.ino()])
}

pub(super) fn activate(bundle: &Path, candidate: &Path) -> Result<(), String> {
    sync_tree(candidate)?;
    let container = bundle.parent().ok_or("Invalid bundle path")?;
    let relative = candidate.strip_prefix(container).map_err(error)?;
    let record = Journal {
        schema: 1,
        candidate: relative.to_owned(),
        old: identity(bundle)?,
        new: identity(candidate)?,
    };
    let bytes = serde_json::to_vec(&record).map_err(error)?;
    crate::secure_fs::replace_private(
        &journal(bundle),
        |file| file.write_all(&bytes).map_err(error),
        error,
    )?;
    checkpoint("journal");
    // Refuse unsupported exchange: a two-rename fallback would lose the only
    // runnable installed pathname. Both trees stay intact on failure.
    crate::secure_fs::exchange_directories(bundle, candidate).map_err(error)?;
    checkpoint("exchange");
    sync_parent(bundle)?;
    sync_parent(candidate)?;
    checkpoint("synced");
    Ok(())
}

pub(super) fn finish(bundle: &Path) -> Result<(), String> {
    let (record, candidate) = read(bundle)?;
    if identity(bundle)? != record.new {
        return Err("Update identity changed".into());
    }
    cleanup(bundle, &record, &candidate)
}

pub(super) fn rollback(bundle: &Path) -> Result<(), String> {
    let (record, candidate) = read(bundle)?;
    if identity(bundle)? != record.new || identity(&candidate)? != record.old {
        return Err("Update rollback identity changed".into());
    }
    crate::secure_fs::exchange_directories(bundle, &candidate).map_err(error)?;
    sync_parent(bundle)?;
    sync_parent(&candidate)?;
    cleanup(bundle, &record, &candidate)
}

pub(super) fn recover(bundle: &Path) -> Result<(), String> {
    if !pending(bundle) {
        return Ok(());
    }
    let (record, candidate) = read(bundle)?;
    let installed = identity(bundle)?;
    if installed != record.old && installed != record.new {
        return Err("Update recovery identity changed".into());
    }
    // An unexchanged intent rolls back; an exchanged intent completes. The
    // installed pathname has been runnable throughout both outcomes.
    cleanup(bundle, &record, &candidate)
}

fn read(bundle: &Path) -> Result<(Journal, PathBuf), String> {
    let file = crate::secure_fs::open_read_no_follow(&journal(bundle)).map_err(error)?;
    let record: Journal = serde_json::from_reader(file.take(16 * 1024)).map_err(error)?;
    let relative = &record.candidate;
    let parts: Vec<_> = relative.components().collect();
    let [
        std::path::Component::Normal(directory),
        std::path::Component::Normal(name),
    ] = parts.as_slice()
    else {
        return Err("Invalid update journal path".into());
    };
    if record.schema != 1
        || !directory.to_string_lossy().starts_with(".butler-update.")
        || *name != "Butler.app"
    {
        return Err("Invalid update journal path".into());
    }
    let container = bundle.parent().ok_or("Invalid bundle path")?;
    let staging = container.join(directory);
    if staging.exists() && !fs::symlink_metadata(&staging).map_err(error)?.is_dir() {
        return Err("Update staging identity changed".into());
    }
    let candidate = container.join(relative);
    Ok((record, candidate))
}

fn cleanup(bundle: &Path, record: &Journal, candidate: &Path) -> Result<(), String> {
    if candidate.exists() {
        let other = identity(candidate)?;
        let installed = identity(bundle)?;
        if !((installed == record.old && other == record.new)
            || (installed == record.new && other == record.old))
        {
            return Err("Update cleanup identity changed".into());
        }
        crate::secure_fs::remove_tree(candidate.parent().ok_or("Invalid staging")?)
            .map_err(error)?;
    }
    checkpoint("cleanup");
    fs::remove_file(journal(bundle)).map_err(error)?;
    sync_parent(bundle)
}

fn sync_tree(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if metadata.is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(error)? {
            sync_tree(&entry.map_err(error)?.path())?;
        }
    }
    crate::secure_fs::sync_path(path).map_err(error)
}

fn sync_parent(path: &Path) -> Result<(), String> {
    crate::secure_fs::sync_directory(path.parent().ok_or("Invalid update path")?)
        .ok_or("Directory sync unavailable")?
        .map_err(error)
}

// A named E2E barrier lets the test kill the real helper after each durable step.
pub(super) fn checkpoint(step: &str) {
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_APP_UPDATE_CHECKPOINT").as_deref() == Ok(step)
    {
        println!("app-update-checkpoint:{step}");
        let _ = std::io::stdout().flush();
        loop {
            std::thread::park();
        }
    }
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(super) fn lease(bundle: &Path) -> Result<Option<fs::File>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    crate::secure_fs::owner_only(&mut options);
    crate::secure_fs::no_follow(&mut options);
    let file = options
        .open(bundle.with_extension("app.update.lock"))
        .map_err(error)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(e) => Err(error(e)),
    }
}
