//! Verified logical copy and atomic replacement with a temporary hard link.
use super::state::{Pages, pages, set};
use super::*;
use crate::btcc::StorageCode;
use butler_platform::secure_fs::abort_point;
use std::collections::BTreeMap;

pub(super) fn run(
    path: &Path,
    db: sqlite::Connection,
    attempts: u32,
    run: &mut Run<'_>,
) -> StorageResult<CorrectionOutcome> {
    let p = pages(&db)?;
    if let Some(reason) = state::admission(path, &p, run.remaining())? {
        state::defer(&db, reason, attempts)?;
        return Ok(CorrectionOutcome::Deferred);
    }
    sidecar(path, "compact", run)?;
    set(&db, "compacting", false, &serde_json::json!({}))?;
    run.hook(&db);
    let counts = counts(&db)?;
    db.progress_handler(0, None::<fn() -> bool>);
    db.close().map_err(|(_, e)| StorageError::sqlite(e))?;
    retire_wal(path)?;
    let tmp = sibling(path, "compact-tmp");
    remove(&tmp)?;
    abort_point("before_vacuum");
    if let Err(e) = copy(path, &tmp, run) {
        remove(&tmp)?;
        return copy_failure(path, &e, attempts, run);
    }
    if let Err(e) = verify(&tmp, &p, &counts, run) {
        remove(&tmp)?;
        if expired(run) {
            return pending_time(path, attempts);
        }
        return failed(
            path,
            "failed_verify",
            StorageCode::StorageCorrectionVerifyFailed,
            &e.to_string(),
        );
    }
    swap(path, &tmp, run)
}

fn copy(path: &Path, tmp: &Path, run: &mut Run<'_>) -> StorageResult<()> {
    let started = Instant::now();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    secure_fs::owner_only(&mut options);
    drop(options.open(tmp).map_err(io_error)?);
    secure_fs::restrict_file(tmp)
        .unwrap_or(Ok(()))
        .map_err(io_error)?;
    let db = reader(path)?;
    run.hook(&db);
    db.pragma_update(None, "mmap_size", sqlite::VALIDATION_MMAP_BYTES)
        .map_err(StorageError::sqlite)?;
    db.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])
        .map_err(StorageError::sqlite)?;
    drop(db);
    (run.progress)("vacuum_into", started.elapsed(), 0);
    let db = sqlite::open(tmp).map_err(StorageError::sqlite)?;
    db.pragma_update(None, "journal_mode", "DELETE")
        .map_err(StorageError::sqlite)?;
    set(&db, "done", false, &serde_json::json!({"compacted":true}))?;
    drop(db);
    secure_fs::sync_path(tmp).map_err(io_error)?;
    secure_fs::sync_path(parent(path)).map_err(io_error)?;
    abort_point("after_tmp_marked");
    Ok(())
}

fn verify(
    path: &Path,
    p: &Pages,
    expected: &BTreeMap<String, u64>,
    run: &mut Run<'_>,
) -> StorageResult<()> {
    let started = Instant::now();
    let db = reader(path)?;
    run.hook(&db);
    db.pragma_update(None, "mmap_size", sqlite::VALIDATION_MMAP_BYTES)
        .map_err(StorageError::sqlite)?;
    let checks = db
        .prepare("PRAGMA integrity_check")
        .map_err(StorageError::sqlite)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::sqlite)?;
    if checks != ["ok"] || pages(&db)?.size != p.size || counts(&db)? != *expected {
        return Err(StorageError::new(
            StorageCode::StorageCorrectionVerifyFailed,
            "copy integrity, page size or counts differ",
        ));
    }
    bootstrap::verify_correction(&db, path)?;
    (run.progress)("verification", started.elapsed(), 0);
    Ok(())
}

fn swap(path: &Path, tmp: &Path, run: &mut Run<'_>) -> StorageResult<CorrectionOutcome> {
    let started = Instant::now();
    if expired(run) {
        remove(tmp)?;
        return pending_time(path, state::read(&*reader(path)?)?.attempts);
    }
    retire_wal(path)?;
    let backup = sibling(path, "precompact");
    remove(&backup)?;
    if let Err(e) = std::fs::hard_link(path, &backup) {
        remove(tmp)?;
        if secure_fs::hard_link_unsupported(&e) {
            set(
                &*writer(path)?,
                "done",
                false,
                &serde_json::json!({"skipped":"no_hardlink"}),
            )?;
            return Ok(CorrectionOutcome::Deferred);
        }
        return failed(
            path,
            "failed_copy",
            StorageCode::StorageCorrectionCopyFailed,
            &e.to_string(),
        );
    }
    secure_fs::sync_path(parent(path)).map_err(io_error)?;
    abort_point("after_link");
    if let Err(e) = secure_fs::rename(tmp, path) {
        remove(tmp)?;
        remove(&backup)?;
        return failed(
            path,
            "failed_copy",
            StorageCode::StorageCorrectionCopyFailed,
            &e.to_string(),
        );
    }
    secure_fs::sync_path(parent(path)).map_err(io_error)?;
    abort_point("after_rename");
    bootstrap::stamp_verified(path)?;
    (run.progress)("swap", started.elapsed(), 0);
    Ok(CorrectionOutcome::Compacted { precompact: true })
}

fn counts(db: &rusqlite::Connection) -> StorageResult<BTreeMap<String, u64>> {
    let tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .map_err(StorageError::sqlite)?
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::sqlite)?;
    tables
        .into_iter()
        .map(|name| {
            let count = db
                .query_row(
                    &format!("SELECT count(*) FROM \"{}\"", name.replace('"', "\"\"")),
                    [],
                    |r| r.get(0),
                )
                .map_err(StorageError::sqlite)?;
            Ok((name, count))
        })
        .collect()
}
fn expired(run: &Run<'_>) -> bool {
    run.stop.is_cancelled() || run.remaining().is_zero()
}
fn pending_time(path: &Path, attempts: u32) -> StorageResult<CorrectionOutcome> {
    state::defer(&*writer(path)?, "pending_time", attempts)?;
    Ok(CorrectionOutcome::Deferred)
}
fn copy_failure(
    path: &Path,
    error: &StorageError,
    attempts: u32,
    run: &Run<'_>,
) -> StorageResult<CorrectionOutcome> {
    if expired(run) {
        return pending_time(path, attempts);
    }
    if matches!(error,StorageError::Sqlite{source} if source.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    {
        state::defer(&*writer(path)?, "pending_space", attempts)?;
        return Ok(CorrectionOutcome::Deferred);
    }
    failed(
        path,
        "failed_copy",
        StorageCode::StorageCorrectionCopyFailed,
        &error.to_string(),
    )
}
fn failed(
    path: &Path,
    state: &str,
    code: StorageCode,
    detail: &str,
) -> StorageResult<CorrectionOutcome> {
    butler_core::diagnostic!("[btcc-storage] {code}: {detail}");
    set(
        &*writer(path)?,
        state,
        false,
        &serde_json::json!({"code":code.as_str()}),
    )?;
    Ok(CorrectionOutcome::Deferred)
}

fn retire_wal(path: &Path) -> StorageResult<()> {
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
        return Err(StorageError::new(
            StorageCode::StorageCorrectionCopyFailed,
            "source WAL not empty",
        ));
    }
    remove(&wal)?;
    remove(&PathBuf::from(format!("{}-shm", path.display())))
}
