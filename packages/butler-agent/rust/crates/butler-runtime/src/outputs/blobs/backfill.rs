use super::super::store::CHANGES;
use super::*;
use butler_platform::secure_fs;
use std::{io::Read, time::Instant};

/// One startup task, invoked on a blocking worker only after agent readiness.
pub(in crate::outputs) fn run(
    store: &OutputStore,
    stop: &tokio_util::sync::CancellationToken,
) -> std::io::Result<()> {
    let started = Instant::now();
    let root = &store.root;
    if root.join("index.sqlite").exists() {
        let migrated = {
            let _lock = CHANGES
                .lock()
                .map_err(|_| error("output_store_unavailable"))?;
            let db = open(root)?;
            complete(&db)?
        };
        if migrated {
            return drain_background(store, stop);
        }
    }
    let mut names = match std::fs::read_dir(root.join("manifests")) {
        Ok(entries) => entries
            .map(|e| e.map(|e| e.file_name()))
            .collect::<Result<Vec<_>, _>>()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    if names.is_empty() && !root.join("index.sqlite").exists() && !root.join("blobs").exists() {
        return Ok(());
    }
    let migrated = {
        let _lock = CHANGES
            .lock()
            .map_err(|_| error("output_store_unavailable"))?;
        let db = open(root)?;
        let migrated = complete(&db)?;
        if !migrated {
            schema(&db, false)?;
        }
        migrated
    };
    if migrated {
        return drain_background(store, stop);
    }
    names.sort();
    let mut db = open(root)?;
    index_remaining(store, &mut db, names, stop)?;
    if stop.is_cancelled() {
        return Ok(());
    }
    {
        let _lock = CHANGES
            .lock()
            .map_err(|_| error("output_store_unavailable"))?;
        sha_index(&db)?;
    }
    queue_orphans(store, &mut db, stop)?;
    if stop.is_cancelled() {
        return Ok(());
    }
    finish(store, &db, started, stop)
}

fn index_remaining(
    store: &OutputStore,
    db: &mut sqlite::Connection,
    names: Vec<std::ffi::OsString>,
    stop: &tokio_util::sync::CancellationToken,
) -> std::io::Result<()> {
    let cursor: String = db
        .query_row(
            "SELECT cursor FROM output_blob_backfill WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(std::io::Error::other)?;
    let names = names
        .into_iter()
        .filter(|n| n.to_string_lossy().as_ref() > cursor.as_str())
        .collect::<Vec<_>>();
    for batch in names.chunks(PAGE) {
        if stop.is_cancelled() {
            return Ok(());
        }
        index_batch(store, db, batch)?;
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    Ok(())
}

fn index_batch(
    store: &OutputStore,
    db: &mut sqlite::Connection,
    batch: &[std::ffi::OsString],
) -> std::io::Result<()> {
    let _lock = CHANGES
        .lock()
        .map_err(|_| error("output_store_unavailable"))?;
    let tx = db.transaction().map_err(std::io::Error::other)?;
    let mut indexed = 0;
    for name in batch {
        if let Some(output) = read(&store.root.join("manifests").join(name))? {
            reconcile(&tx, &output)?;
            indexed += 1;
        }
    }
    let last = batch
        .last()
        .ok_or_else(|| error("output_backfill_batch"))?
        .to_string_lossy();
    tx.execute(
        "UPDATE output_blob_backfill SET cursor=?1,indexed=indexed+?2 WHERE id=1",
        params![last.as_ref(), indexed],
    )
    .map_err(std::io::Error::other)?;
    tx.commit().map_err(std::io::Error::other)?;
    Ok(())
}

fn finish(
    store: &OutputStore,
    db: &Connection,
    started: Instant,
    stop: &tokio_util::sync::CancellationToken,
) -> std::io::Result<()> {
    let (indexed, queued): (u64, u64) = {
        let _lock = CHANGES
            .lock()
            .map_err(|_| error("output_store_unavailable"))?;
        db.execute("UPDATE output_blob_backfill SET complete=1 WHERE id=1", [])
            .map_err(std::io::Error::other)?;
        db.query_row(
            "SELECT indexed,queued FROM output_blob_backfill WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(std::io::Error::other)?
    };
    drain_background(store, stop)?;
    butler_core::diagnostic!(
        "[outputs] output blob backfill finished: outputs_indexed={indexed} blobs_queued={queued} elapsed_ms={}",
        started.elapsed().as_millis()
    );
    Ok(())
}

fn read(path: &Path) -> std::io::Result<Option<Output>> {
    let mut bytes = Vec::new();
    match secure_fs::open_read_no_follow(path).and_then(|mut f| f.read_to_end(&mut bytes)) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    }
    match serde_json::from_slice(&bytes) {
        Ok(output) => Ok(Some(output)),
        Err(e) => {
            butler_core::diagnostic!("[outputs] unreadable manifest {}: {e}", path.display());
            Ok(None)
        }
    }
}

/// Enumerate shards once, outside CHANGES; inspect each bounded batch under
/// the publication lock, so any observed replacement temp file is stale.
fn queue_orphans(
    store: &OutputStore,
    db: &mut sqlite::Connection,
    stop: &tokio_util::sync::CancellationToken,
) -> std::io::Result<()> {
    let shards = match std::fs::read_dir(store.root.join("blobs")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut batch = Vec::with_capacity(PAGE);
    for shard in shards {
        if stop.is_cancelled() {
            return Ok(());
        }
        let shard = shard?;
        if !shard.file_type()?.is_dir() {
            butler_core::diagnostic!(
                "[outputs] skipping non-directory blob shard {}",
                shard.path().display()
            );
            continue;
        }
        for blob in std::fs::read_dir(shard.path())? {
            batch.push(blob?.path());
            if batch.len() == PAGE {
                queue_batch(store, db, &batch)?;
                batch.clear();
                if stop.is_cancelled() {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        }
    }
    queue_batch(store, db, &batch)
}

fn orphan_sha(store: &OutputStore, path: &Path) -> std::io::Result<Option<String>> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if meta.is_dir() {
        butler_core::diagnostic!(
            "[outputs] skipping directory inside blob shard {}",
            path.display()
        );
        return Ok(None);
    }
    let name = path
        .file_name()
        .ok_or_else(|| error("blob_name_missing"))?
        .to_string_lossy();
    if store.blob(&name).is_ok() {
        return Ok(Some(name.into_owned()));
    }
    if name.starts_with('.') && name.ends_with(".tmp") {
        if let Err(e) = std::fs::remove_file(path)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            butler_core::diagnostic!(
                "[outputs] stale blob temp unlink failed {}: {e}",
                path.display()
            );
        }
    } else {
        butler_core::diagnostic!("[outputs] skipping invalid blob name {}", path.display());
    }
    Ok(None)
}

fn queue_batch(
    store: &OutputStore,
    db: &mut sqlite::Connection,
    batch: &[std::path::PathBuf],
) -> std::io::Result<()> {
    if batch.is_empty() {
        return Ok(());
    }
    let _lock = CHANGES
        .lock()
        .map_err(|_| error("output_store_unavailable"))?;
    let tx = db.transaction().map_err(std::io::Error::other)?;
    let mut queued = 0;
    for path in batch {
        if let Some(sha) = orphan_sha(store, path)? {
            queued += tx.execute("INSERT OR IGNORE INTO output_blob_sweep SELECT ?1 WHERE NOT EXISTS(SELECT 1 FROM output_blobs WHERE sha=?1)", [sha])
                .map_err(std::io::Error::other)?;
        }
    }
    if queued > 0 {
        tx.execute(
            "UPDATE output_blob_backfill SET queued=queued+?1 WHERE id=1",
            [queued],
        )
        .map_err(std::io::Error::other)?;
    }
    tx.commit().map_err(std::io::Error::other)
}
