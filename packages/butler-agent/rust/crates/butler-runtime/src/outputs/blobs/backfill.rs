use super::super::store::CHANGES;
use super::*;
use butler_platform::secure_fs;
use std::{io::Read, time::Instant};

const INDEX_BATCH: usize = 512;

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
        // Bound the one-time sort cache, avoiding temporary runs for small indexes.
        db.execute_batch("PRAGMA cache_size=-65536")
            .map_err(std::io::Error::other)?;
        sha_index(&db)?;
    }
    let skip_orphans: bool = db
        .query_row(
            "SELECT skip_orphans FROM output_blob_backfill WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(std::io::Error::other)?;
    if skip_orphans {
        butler_core::diagnostic!("[outputs] orphan pass skipped: uncertain manifest ownership");
    } else {
        queue_orphans(store, &mut db, stop)?;
    }
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
    for batch in names.chunks(INDEX_BATCH) {
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
    // Disk reads and JSON parsing do not hold up publication. Only the current
    // file version may reconcile rows after acquiring the publication lock.
    let prepared = batch
        .iter()
        .filter(|name| {
            let valid = name
                .to_str()
                .and_then(|name| name.strip_suffix(".json"))
                .is_some_and(|id| store.manifest(id).is_ok());
            if !valid {
                butler_core::diagnostic!("[outputs] skipping non-manifest file {name:?}");
            }
            valid
        })
        .map(|name| {
            let path = store.root.join("manifests").join(name);
            read(&path).map(|snapshot| (path, snapshot))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let _lock = CHANGES
        .lock()
        .map_err(|_| error("output_store_unavailable"))?;
    let tx = db.transaction().map_err(std::io::Error::other)?;
    let mut indexed = 0;
    for (path, snapshot) in prepared {
        let uncertain = log_uncertain(&path, snapshot.as_ref());
        if uncertain {
            // Even a malformed snapshot superseded by publication makes this
            // run conservative. Persist this together with its batch cursor.
            tx.execute(
                "UPDATE output_blob_backfill SET skip_orphans=1 WHERE id=1",
                [],
            )
            .map_err(std::io::Error::other)?;
        }
        if let Some(snapshot) = current(&path, snapshot)? {
            if !uncertain {
                log_uncertain(&path, Some(&snapshot));
            }
            index_manifest(&tx, snapshot.manifest)?;
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

enum Manifest {
    Parsed(Output),
    Uncertain {
        id: String,
        shas: BTreeSet<String>,
        diagnostic: serde_json::Error,
    },
}

fn log_uncertain(path: &Path, snapshot: Option<&Snapshot>) -> bool {
    if let Some(Snapshot {
        manifest: Manifest::Uncertain { diagnostic, .. },
        ..
    }) = snapshot
    {
        butler_core::diagnostic!(
            "[outputs] unreadable manifest {}; orphan pass skipped: {diagnostic}",
            path.display()
        );
        return true;
    }
    false
}

fn index_manifest(db: &Connection, manifest: Manifest) -> std::io::Result<()> {
    match manifest {
        Manifest::Parsed(output) => reconcile(db, &output),
        Manifest::Uncertain { id, shas, .. } => {
            for sha in shas {
                db.execute(
                    "INSERT OR IGNORE INTO output_blobs(sha,output_id) VALUES(?1,?2)",
                    params![sha, id],
                )
                .map_err(std::io::Error::other)?;
            }
            db.execute(
                "UPDATE output_blob_backfill SET skip_orphans=1 WHERE id=1",
                [],
            )
            .map_err(std::io::Error::other)?;
            Ok(())
        }
    }
}

// Preserve even references embedded in an unknown format or cut off mid-write.
fn raw_shas(bytes: &[u8]) -> BTreeSet<String> {
    bytes
        .split(|b| !b.is_ascii_hexdigit())
        .filter(|run| run.len() == 64 && !run.iter().any(u8::is_ascii_uppercase))
        .map(|sha| String::from_utf8_lossy(sha).into_owned())
        .collect()
}

struct Snapshot {
    identity: secure_fs::FileIdentity,
    len: u64,
    manifest: Manifest,
}

fn read(path: &Path) -> std::io::Result<Option<Snapshot>> {
    let mut file = match secure_fs::open_read_no_follow(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let metadata = file.metadata()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let manifest = match serde_json::from_slice(&bytes) {
        Ok(output) => Manifest::Parsed(output),
        Err(e) => {
            let id = path
                .file_stem()
                .ok_or_else(|| error("manifest_stem_missing"))?
                .to_string_lossy()
                .into_owned();
            Manifest::Uncertain {
                id,
                shas: raw_shas(&bytes),
                diagnostic: e,
            }
        }
    };
    Ok(Some(Snapshot {
        identity: secure_fs::identity(&metadata),
        len: metadata.len(),
        manifest,
    }))
}

// Called only under CHANGES, including when the initial unlocked read missed a
// file that publication has since created. I/O errors still fail closed.
fn current(path: &Path, snapshot: Option<Snapshot>) -> std::io::Result<Option<Snapshot>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let identity = secure_fs::identity(&metadata);
    if let Some(snapshot) = snapshot
        && snapshot.len == metadata.len()
        && match identity.id {
            Some(_) => snapshot.identity == identity,
            // Atomic publication replaces a freshly written temp. Without a
            // file ID, matching known modification time and length suffice.
            None => identity.modified.is_some() && snapshot.identity.modified == identity.modified,
        }
    {
        return Ok(Some(snapshot));
    }
    read(path)
}

/// Enumerate shards once, outside CHANGES; inspect each bounded batch under
/// the publication lock, so any observed replacement temp file is stale.
fn queue_orphans(
    store: &OutputStore,
    db: &mut sqlite::Connection,
    stop: &tokio_util::sync::CancellationToken,
) -> std::io::Result<()> {
    let mut shards = match std::fs::read_dir(store.root.join("blobs")) {
        Ok(entries) => entries.collect::<Result<Vec<_>, _>>()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    shards.sort_by_key(std::fs::DirEntry::file_name);
    let cursor: String = db
        .query_row(
            "SELECT orphan_cursor FROM output_blob_backfill WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(std::io::Error::other)?;
    for shard in shards {
        if stop.is_cancelled() {
            return Ok(());
        }
        let name = shard.file_name().to_string_lossy().into_owned();
        if name <= cursor {
            continue;
        }
        if !shard.file_type()?.is_dir() {
            butler_core::diagnostic!(
                "[outputs] skipping non-directory blob shard {}",
                shard.path().display()
            );
            continue;
        }
        let mut entries = std::fs::read_dir(shard.path())?.peekable();
        loop {
            let batch = entries
                .by_ref()
                .take(PAGE)
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<Result<Vec<_>, _>>()?;
            let done = entries.peek().is_none();
            queue_batch(store, db, &batch, done.then_some(name.as_str()))?;
            if stop.is_cancelled() {
                return Ok(());
            }
            if batch.len() == PAGE {
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            if done {
                break;
            }
        }
    }
    Ok(())
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
    completed_shard: Option<&str>,
) -> std::io::Result<()> {
    if batch.is_empty() && completed_shard.is_none() {
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
    if let Some(shard) = completed_shard {
        tx.execute(
            "UPDATE output_blob_backfill SET orphan_cursor=?1 WHERE id=1",
            [shard],
        )
        .map_err(std::io::Error::other)?;
    }
    tx.commit().map_err(std::io::Error::other)
}
