//! Durable, keyed blob ownership and replayable collection. Callers hold CHANGES.
use super::store::{Output, OutputStore, error, hash};
use butler_platform::sqlite;
use rusqlite::{Connection, params};
use std::{collections::BTreeSet, path::Path};

mod backfill;
pub(super) use backfill::run;
const PAGE: usize = 128;

pub(super) fn schema(db: &Connection, empty: bool) -> std::io::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS output_blobs(sha TEXT NOT NULL, output_id TEXT NOT NULL, PRIMARY KEY(output_id,sha)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS output_blob_sweep(sha TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS output_blob_backfill(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL, complete INTEGER NOT NULL, indexed INTEGER NOT NULL, queued INTEGER NOT NULL);")
        .map_err(std::io::Error::other)?;
    db.execute(
        "INSERT OR IGNORE INTO output_blob_backfill VALUES(1,'',?1,0,0)",
        [empty],
    )
    .map_err(std::io::Error::other)?;
    if empty {
        sha_index(db)?;
    }
    Ok(())
}

fn sha_index(db: &Connection) -> std::io::Result<()> {
    let started = std::time::Instant::now();
    db.execute_batch("CREATE INDEX IF NOT EXISTS output_blobs_sha ON output_blobs(sha)")
        .map_err(std::io::Error::other)?;
    butler_core::diagnostic!(
        "[outputs] blob sha index ready: changes_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(())
}

fn has_state(db: &Connection) -> std::io::Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='output_blob_backfill')", [], |r| r.get(0))
        .map_err(std::io::Error::other)
}

fn complete(db: &Connection) -> std::io::Result<bool> {
    if !has_state(db)? {
        return Ok(false);
    }
    db.query_row(
        "SELECT COALESCE((SELECT complete FROM output_blob_backfill WHERE id=1),0)",
        [],
        |r| r.get(0),
    )
    .map_err(std::io::Error::other)
}

fn open(root: &Path) -> std::io::Result<sqlite::Connection> {
    sqlite::open(root.join("index.sqlite")).map_err(std::io::Error::other)
}

/// Establish a fresh store before staging its first blobs. Existing blob
/// directories require the startup sweep even if no manifests remain.
pub(super) fn initialize(root: &Path) -> std::io::Result<()> {
    if root.join("index.sqlite").exists() {
        return Ok(());
    }
    let empty = match std::fs::read_dir(root.join("manifests")) {
        Ok(mut entries) => entries.next().transpose()?.is_none(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => return Err(e),
    };
    let fresh = empty && !root.join("blobs").exists();
    butler_platform::secure_fs::create_private_dir_all(root)?;
    let mut db = open(root)?;
    let tx = db.transaction().map_err(std::io::Error::other)?;
    schema(&tx, fresh)?;
    tx.commit().map_err(std::io::Error::other)
}

/// Commit additions before the manifest's atomic replacement. A failed publish
/// may leave extra references; it can never expose an unprotected durable blob.
pub(super) fn protect(root: &Path, output: &Output) -> std::io::Result<()> {
    let mut db = open(root)?;
    let tx = db.transaction().map_err(std::io::Error::other)?;
    schema(&tx, false)?;
    add(&tx, output)?;
    tx.commit().map_err(std::io::Error::other)
}

fn add(db: &Connection, output: &Output) -> std::io::Result<()> {
    let mut insert = db
        .prepare_cached("INSERT OR IGNORE INTO output_blobs(sha,output_id) VALUES(?1,?2)")
        .map_err(std::io::Error::other)?;
    for sha in shas(output) {
        insert
            .execute(params![sha, output.output_id])
            .map_err(std::io::Error::other)?;
    }
    Ok(())
}

fn shas(output: &Output) -> BTreeSet<&str> {
    output
        .revisions
        .iter()
        .flat_map(|r| r.files.values().map(String::as_str))
        .collect()
}

/// Reconcile all current revisions in the very same transaction as outputs.
pub(super) fn reconcile(db: &Connection, output: &Output) -> std::io::Result<()> {
    let current = shas(output);
    for sha in strings(
        db,
        "SELECT sha FROM output_blobs WHERE output_id=?1",
        &output.output_id,
    )? {
        if !current.contains(sha.as_str()) {
            queue(db, &sha)?;
            db.execute(
                "DELETE FROM output_blobs WHERE sha=?1 AND output_id=?2",
                params![sha, output.output_id],
            )
            .map_err(std::io::Error::other)?;
        }
    }
    add(db, output)
}

fn strings(db: &Connection, sql: &str, key: &str) -> std::io::Result<Vec<String>> {
    db.prepare(sql)
        .map_err(std::io::Error::other)?
        .query_map([key], |r| r.get(0))
        .map_err(std::io::Error::other)?
        .collect::<Result<_, _>>()
        .map_err(std::io::Error::other)
}

fn queue(db: &Connection, sha: &str) -> std::io::Result<()> {
    db.execute("INSERT OR IGNORE INTO output_blob_sweep VALUES(?1)", [sha])
        .map_err(std::io::Error::other)?;
    Ok(())
}

/// Persist candidates before deleting any manifest. Until migration completes,
/// the session's own marker directory supplies references absent from the index.
pub(super) fn queue_session(
    store: &OutputStore,
    session: &str,
) -> std::io::Result<(Vec<String>, BTreeSet<String>)> {
    let root = &store.root;
    let markers = root.join("sessions").join(hash(session.as_bytes()));
    let mut ids = BTreeSet::new();
    match std::fs::read_dir(markers) {
        Ok(entries) => {
            for entry in entries {
                ids.insert(entry?.file_name().to_string_lossy().into_owned());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    if ids.is_empty() && !root.join("index.sqlite").exists() {
        return Ok((Vec::new(), BTreeSet::new()));
    }
    let mut db = open(root)?;
    let tx = db.transaction().map_err(std::io::Error::other)?;
    schema(&tx, false)?;
    if super::index::ready(&tx)? {
        ids.extend(strings(
            &tx,
            "SELECT id FROM outputs WHERE session=?1",
            session,
        )?);
    }
    let migrated = complete(&tx)?;
    let mut candidates = BTreeSet::new();
    for id in &ids {
        if !migrated {
            match store.read(id) {
                Ok(output) => {
                    for sha in shas(&output) {
                        candidates.insert(sha.to_owned());
                        queue(&tx, sha)?;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        for sha in strings(&tx, "SELECT sha FROM output_blobs WHERE output_id=?1", id)? {
            queue(&tx, &sha)?;
            candidates.insert(sha);
        }
    }
    tx.commit().map_err(std::io::Error::other)?;
    Ok((ids.into_iter().collect(), candidates))
}

pub(super) fn remove(db: &Connection, ids: &[String]) -> std::io::Result<()> {
    for id in ids {
        db.execute("INSERT OR IGNORE INTO output_blob_sweep SELECT sha FROM output_blobs WHERE output_id=?1", [id])
            .map_err(std::io::Error::other)?;
        db.execute("DELETE FROM output_blobs WHERE output_id=?1", [id])
            .map_err(std::io::Error::other)?;
    }
    Ok(())
}

/// No manifests or directory enumeration: only queue pages and keyed ownership.
pub(super) fn drain(store: &OutputStore, candidates: &BTreeSet<String>) -> std::io::Result<()> {
    if !store.root.join("index.sqlite").exists() {
        return Ok(());
    }
    let mut db = open(&store.root)?;
    if !complete(&db)? {
        return Ok(());
    }
    for batch in candidates.iter().cloned().collect::<Vec<_>>().chunks(PAGE) {
        drain_shas(store, &mut db, batch)?;
    }
    // The request owns only its candidates and one page of unrelated debt.
    drain_page(store, &mut db, None)?;
    Ok(())
}

/// Startup recovery yields CHANGES between sweep pages as well as index pages.
pub(super) fn drain_background(
    store: &OutputStore,
    stop: &tokio_util::sync::CancellationToken,
) -> std::io::Result<()> {
    let mut db = open(&store.root)?;
    let mut after = None;
    while !stop.is_cancelled() {
        let next = {
            let _lock = super::store::CHANGES
                .lock()
                .map_err(|_| error("output_store_unavailable"))?;
            if !complete(&db)? {
                return Ok(());
            }
            drain_page(store, &mut db, after.as_deref())?
        };
        let Some(next) = next else {
            return Ok(());
        };
        after = Some(next);
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    Ok(())
}

fn drain_page(
    store: &OutputStore,
    db: &mut sqlite::Connection,
    after: Option<&str>,
) -> std::io::Result<Option<String>> {
    let sql = if after.is_some() {
        "SELECT sha FROM output_blob_sweep WHERE sha>?1 ORDER BY sha LIMIT 128"
    } else {
        "SELECT sha FROM output_blob_sweep WHERE sha>=?1 ORDER BY sha LIMIT 128"
    };
    let page = strings(db, sql, after.unwrap_or(""))?;
    if page.is_empty() {
        return Ok(None);
    }
    drain_shas(store, db, &page)?;
    Ok(page.last().cloned())
}

fn drain_shas(
    store: &OutputStore,
    db: &mut sqlite::Connection,
    page: &[String],
) -> std::io::Result<()> {
    let tx = db.transaction().map_err(std::io::Error::other)?;
    for sha in page {
        let path = match store.blob(sha) {
            Ok(path) => Some(path),
            Err(e) => {
                butler_core::diagnostic!("[outputs] discarding invalid cleanup name {sha:?}: {e}");
                None
            }
        };
        if let Some(path) = path {
            let live: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM output_blobs WHERE sha=?1)",
                    [sha],
                    |r| r.get(0),
                )
                .map_err(std::io::Error::other)?;
            if !live
                && let Err(e) = std::fs::remove_file(&path)
                && e.kind() != std::io::ErrorKind::NotFound
            {
                butler_core::diagnostic!("[outputs] blob unlink deferred {}: {e}", path.display());
                continue;
            }
        }
        tx.execute("DELETE FROM output_blob_sweep WHERE sha=?1", [sha])
            .map_err(std::io::Error::other)?;
    }
    tx.commit().map_err(std::io::Error::other)
}
