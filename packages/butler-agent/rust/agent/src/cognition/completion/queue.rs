use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use rusqlite::{Connection, ErrorCode, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::TypedMemorySourceNotice;
use super::observation::PublishedObservation;
use crate::cognition::{CognitionError, CognitionResult};

pub(super) fn append(
    root: &Path,
    observation: &PublishedObservation,
    created_at: &str,
    acquired_at: &str,
) -> CognitionResult<()> {
    let parent = root.join("queue");
    let path = parent.join("sync.jsonl");
    fs::create_dir_all(&parent).map_err(io_error)?;
    let lock_path = path.with_extension("jsonl.coord.sqlite");
    let db = Connection::open(lock_path).map_err(sqlite_error)?;
    db.busy_timeout(std::time::Duration::ZERO)
        .map_err(sqlite_error)?;
    db.execute_batch("BEGIN EXCLUSIVE").map_err(|error| {
        if matches!(error, rusqlite::Error::SqliteFailure(inner, _) if inner.code == ErrorCode::DatabaseBusy || inner.code == ErrorCode::DatabaseLocked) {
            CognitionError::new("memory_queue_busy", "memory_queue_busy")
        } else { sqlite_error(error) }
    })?;
    let result = (|| {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS queue_lock_owner(\
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\
            pid INTEGER NOT NULL, nonce TEXT NOT NULL, acquired_at TEXT NOT NULL)",
        )
        .map_err(sqlite_error)?;
        db.execute("INSERT INTO queue_lock_owner(singleton,pid,nonce,acquired_at) VALUES(1,?1,?2,?3) \
            ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce,acquired_at=excluded.acquired_at",
            params![std::process::id(), uuid::Uuid::new_v4().to_string(), acquired_at]).map_err(sqlite_error)?;
        let request = json!({
            "schema_version": "butler.memory-sync-request.v3",
            "job_id": observation.job_id,
            "source": {
                "kind": "conversation_turn",
                "session_id": observation.session_id,
                "turn_id": observation.turn_id,
                "outcome_generation": observation.generation,
            },
            "created_at": created_at,
        });
        if queued(&path, &observation.job_id)? {
            return Ok(());
        }
        let existed = path.exists();
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(io_error)?;
        file.write_all(request.to_string().as_bytes())
            .map_err(io_error)?;
        file.write_all(b"\n").map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        if !existed {
            File::open(parent)
                .and_then(|dir| dir.sync_all())
                .map_err(io_error)?;
        }
        Ok(())
    })();
    if result.is_ok() {
        db.execute_batch("COMMIT").map_err(sqlite_error)?;
    } else {
        let _ = db.execute_batch("ROLLBACK");
    }
    result
}

pub(super) fn append_typed(
    root: &Path,
    notice: &TypedMemorySourceNotice,
    created_at: &str,
) -> CognitionResult<String> {
    let job_id = notice.job_id()?;
    let source = notice.source_json()?;
    let entry = format!(
        "{{\"schema_version\":\"butler.memory-sync-request.v3\",\"job_id\":{},\"source\":{},\"created_at\":{}}}",
        json_string(&job_id)?,
        source,
        json_string(created_at)?,
    );
    append_idempotent(root, &job_id, &entry, created_at)?;
    Ok(job_id)
}

pub(super) fn append_feedback_quality(
    root: &Path,
    feedback_id: &str,
    operation_id: &str,
    revision: &str,
    created_at: &str,
) -> CognitionResult<String> {
    let job_id = format!(
        "{:x}",
        Sha256::digest(format!("feedback-quality:{operation_id}").as_bytes())
    );
    let source = format!(
        "{{\"kind\":\"explicit_record\",\"record_kind\":\"feedback\",\"record_id\":{},\"revision\":{},\"operation_id\":{}}}",
        json_string(feedback_id)?,
        json_string(revision)?,
        json_string(operation_id)?,
    );
    let entry = format!(
        "{{\"schema_version\":\"butler.memory-sync-request.v3\",\"job_id\":{},\"source\":{},\"created_at\":{}}}",
        json_string(&job_id)?,
        source,
        json_string(created_at)?,
    );
    append_idempotent(root, &job_id, &entry, created_at)?;
    Ok(job_id)
}

fn append_idempotent(
    root: &Path,
    job_id: &str,
    entry: &str,
    acquired_at: &str,
) -> CognitionResult<()> {
    let parent = root.join("queue");
    let path = parent.join("sync.jsonl");
    fs::create_dir_all(&parent).map_err(io_error)?;
    let lock_path = path.with_extension("jsonl.coord.sqlite");
    let db = Connection::open(lock_path).map_err(sqlite_error)?;
    db.busy_timeout(std::time::Duration::ZERO)
        .map_err(sqlite_error)?;
    db.execute_batch("BEGIN EXCLUSIVE").map_err(|error| {
        if matches!(error, rusqlite::Error::SqliteFailure(inner, _) if inner.code == ErrorCode::DatabaseBusy || inner.code == ErrorCode::DatabaseLocked) {
            CognitionError::new("memory_queue_busy", "memory_queue_busy")
        } else {
            sqlite_error(error)
        }
    })?;
    let result = (|| {
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS queue_lock_owner(\
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),\
            pid INTEGER NOT NULL, nonce TEXT NOT NULL, acquired_at TEXT NOT NULL)",
        )
        .map_err(sqlite_error)?;
        db.execute(
            "INSERT INTO queue_lock_owner(singleton,pid,nonce,acquired_at) VALUES(1,?1,?2,?3) \
             ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce,acquired_at=excluded.acquired_at",
            params![std::process::id(), uuid::Uuid::new_v4().to_string(), acquired_at],
        )
        .map_err(sqlite_error)?;
        if queued(&path, job_id)? {
            return Ok(());
        }
        let existed = path.exists();
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(io_error)?;
        file.write_all(entry.as_bytes()).map_err(io_error)?;
        file.write_all(b"\n").map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        if !existed {
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(io_error)?;
        }
        Ok(())
    })();
    if result.is_ok() {
        db.execute_batch("COMMIT").map_err(sqlite_error)?;
    } else {
        let _ = db.execute_batch("ROLLBACK");
    }
    result
}

fn json_string(value: &str) -> CognitionResult<String> {
    crate::json::stringify(&Value::String(value.to_owned()))
        .map_err(|error| CognitionError::new("memory_queue_invalid_json", error.to_string()))
}

fn queued(path: &Path, id: &str) -> CognitionResult<bool> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error(error)),
    };
    for line in BufReader::new(file).lines() {
        let line = line.map_err(io_error)?;
        if line.is_empty() {
            continue;
        }
        let entry: Value = serde_json::from_str(&line)
            .map_err(|error| CognitionError::new("memory_queue_invalid_json", error.to_string()))?;
        if entry["job_id"] == id {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn peek(root: &Path) -> CognitionResult<Option<Value>> {
    let path = root.join("queue/sync.jsonl");
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    for line in BufReader::new(file).lines() {
        let line = line.map_err(io_error)?;
        if !line.is_empty() {
            return serde_json::from_str(&line)
                .map(Some)
                .map_err(|e| CognitionError::new("memory_queue_invalid_json", e.to_string()));
        }
    }
    Ok(None)
}

/// Acknowledge only the source job actually processed. A crash before rename
/// leaves the original queue intact; replayed registration is idempotent.
pub(super) fn ack(root: &Path, expected: &str) -> CognitionResult<bool> {
    let path = root.join("queue/sync.jsonl");
    let lock_path = path.with_extension("jsonl.coord.sqlite");
    let db = Connection::open(lock_path).map_err(sqlite_error)?;
    db.busy_timeout(std::time::Duration::ZERO)
        .map_err(sqlite_error)?;
    db.execute_batch("BEGIN EXCLUSIVE").map_err(sqlite_error)?;
    let result = rewrite_without(&path, expected);
    if result.is_ok() {
        db.execute_batch("COMMIT").map_err(sqlite_error)?;
    } else {
        let _ = db.execute_batch("ROLLBACK");
    }
    result
}

fn rewrite_without(path: &Path, expected: &str) -> CognitionResult<bool> {
    let original = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error(error)),
    };
    let temporary = path.with_extension(format!(
        "jsonl.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temporary).map_err(io_error)?;
        let mut removed = false;
        for line in BufReader::new(original).lines() {
            let line = line.map_err(io_error)?;
            let value: Value = serde_json::from_str(&line)
                .map_err(|e| CognitionError::new("memory_queue_invalid_json", e.to_string()))?;
            if !removed && value["job_id"] == expected {
                removed = true;
                continue;
            }
            output.write_all(line.as_bytes()).map_err(io_error)?;
            output.write_all(b"\n").map_err(io_error)?;
        }
        if !removed {
            return Ok(false);
        }
        output.sync_all().map_err(io_error)?;
        drop(output);
        fs::rename(&temporary, path).map_err(io_error)?;
        if let Some(parent) = path.parent() {
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(io_error)?;
        }
        Ok(true)
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new("memory_queue_io_error", error.to_string())
}
fn sqlite_error(error: rusqlite::Error) -> CognitionError {
    CognitionError::new("memory_queue_sqlite_error", error.to_string())
}
