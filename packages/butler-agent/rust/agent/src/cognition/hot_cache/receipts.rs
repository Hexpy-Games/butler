//! Legacy indexing receipts written after the vector rows, even if graph extraction warns.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use chrono::{DateTime, Utc};
use serde_json::json;

use crate::cognition::{CognitionError, CognitionResult, ensure_data_authority};

use super::legacy_graph;

pub(super) fn record(
    data_root: &Path,
    memory_root: &Path,
    text: &str,
    session_id: &str,
    chunk_count: usize,
    row_count: usize,
    temp: &Path,
) -> CognitionResult<()> {
    let db = memory_root.join("db");
    let provenance = db.join("session-provenance.jsonl");
    let stats = db.join("vector-stats.json");
    let log = data_root.join("logs/memory.log");
    ensure_data_authority(data_root, &[memory_root, &db, &provenance, &stats, &log])?;
    let graph_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error("hot_cache_clock_unavailable"))?
        .as_secs() as i64;
    if let Err(failure) = legacy_graph::extract_and_save(
        data_root,
        memory_root,
        text,
        session_id,
        "butler",
        Some("hot-cache"),
        graph_seconds,
    ) {
        eprintln!("Warning: graph extraction failed ({failure})");
    }
    let indexed_at = DateTime::<Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    fs::create_dir_all(&db).map_err(|_| error("hot_cache_receipt_failed"))?;
    let mut receipt = append_private(&provenance)?;
    writeln!(receipt, "{}", json!({"session_id":session_id,"source_session_id":session_id,"project":"butler","source":"hot-cache","topic":null,"source_message_ids":[],"indexed_at":indexed_at,"chunk_count":chunk_count})).map_err(|_| error("hot_cache_receipt_failed"))?;
    let value = json!({"table":"butler_memory","row_count":row_count,"updated_at":indexed_at,"last_session_id":session_id,"last_source_session_id":session_id,"last_source_message_ids":[],"last_chunk_count":chunk_count});
    let serialized =
        serde_json::to_vec_pretty(&value).map_err(|_| error("hot_cache_receipt_failed"))?;
    ensure_data_authority(data_root, &[temp])?;
    let result: CognitionResult<()> = (|| {
        let mut output = create_private(temp)?;
        if let Ok(metadata) = fs::metadata(&stats) {
            fs::set_permissions(temp, metadata.permissions())
                .map_err(|_| error("hot_cache_receipt_failed"))?;
        }
        output
            .write_all(&serialized)
            .and_then(|()| output.write_all(b"\n"))
            .and_then(|()| output.sync_all())
            .map_err(|_| error("hot_cache_receipt_failed"))?;
        fs::rename(temp, &stats).map_err(|_| error("hot_cache_receipt_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result?;
    let parent = log
        .parent()
        .ok_or_else(|| error("hot_cache_receipt_failed"))?;
    fs::create_dir_all(parent).map_err(|_| error("hot_cache_receipt_failed"))?;
    let mut output = append_private(&log)?;
    let date = indexed_at.replace('T', " ");
    writeln!(
        output,
        "[{}] index.ts | project=butler session={session_id} | chunks={chunk_count}",
        &date[..19]
    )
    .map_err(|_| error("hot_cache_receipt_failed"))?;
    Ok(())
}

pub(super) fn record_legacy(input: LegacyReceiptInput<'_>) -> CognitionResult<()> {
    let LegacyReceiptInput {
        data_root,
        memory_root,
        text,
        session_id,
        source_session_id,
        project,
        source,
        topic,
        strict,
        chunk_count,
        row_count,
        temp,
    } = input;
    let db = memory_root.join("db");
    let provenance = db.join("session-provenance.jsonl");
    let stats = db.join("vector-stats.json");
    let log = data_root.join("logs/memory.log");
    ensure_data_authority(
        data_root,
        &[memory_root, &db, &provenance, &stats, temp, &log],
    )?;
    let graph_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| error("legacy_session_clock_unavailable"))?
        .as_secs() as i64;
    let graph = legacy_graph::extract_and_save(
        data_root,
        memory_root,
        text,
        session_id,
        project,
        Some(source),
        graph_seconds,
    );
    if let Err(code) = graph {
        if strict {
            return Err(CognitionError::new("legacy_session_graph_failed", code));
        }
        eprintln!("Warning: graph extraction failed ({code})");
    }
    let indexed_at = DateTime::<Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    fs::create_dir_all(&db).map_err(|_| error("legacy_session_receipt_failed"))?;
    let mut receipt = append_private(&provenance)?;
    writeln!(
        receipt,
        "{}",
        json!({
            "session_id": session_id, "source_session_id": source_session_id,
            "project": project, "source": source, "topic": topic,
            "source_message_ids": [], "indexed_at": indexed_at, "chunk_count": chunk_count,
        })
    )
    .map_err(|_| error("legacy_session_receipt_failed"))?;
    let value = json!({
        "table": "butler_memory", "row_count": row_count, "updated_at": indexed_at,
        "last_session_id": session_id, "last_source_session_id": source_session_id,
        "last_source_message_ids": [], "last_chunk_count": chunk_count,
    });
    let serialized =
        serde_json::to_vec_pretty(&value).map_err(|_| error("legacy_session_receipt_failed"))?;
    let result: CognitionResult<()> = (|| {
        let mut output = create_private(temp)?;
        if let Ok(metadata) = fs::metadata(&stats) {
            fs::set_permissions(temp, metadata.permissions())
                .map_err(|_| error("legacy_session_receipt_failed"))?;
        }
        output
            .write_all(&serialized)
            .and_then(|()| output.write_all(b"\n"))
            .and_then(|()| output.sync_all())
            .map_err(|_| error("legacy_session_receipt_failed"))?;
        fs::rename(temp, &stats).map_err(|_| error("legacy_session_receipt_failed"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result?;
    let parent = log
        .parent()
        .ok_or_else(|| error("legacy_session_receipt_failed"))?;
    fs::create_dir_all(parent).map_err(|_| error("legacy_session_receipt_failed"))?;
    let mut output = append_private(&log)?;
    writeln!(
        output,
        "[{}] index.ts | project={project} session={session_id} | chunks={chunk_count}",
        indexed_at.replace('T', " ").get(..19).unwrap_or("")
    )
    .map_err(|_| error("legacy_session_receipt_failed"))?;
    Ok(())
}

#[derive(Clone, Copy)]
pub(super) struct LegacyReceiptInput<'a> {
    pub data_root: &'a Path,
    pub memory_root: &'a Path,
    pub text: &'a str,
    pub session_id: &'a str,
    pub source_session_id: &'a str,
    pub project: &'a str,
    pub source: &'a str,
    pub topic: Option<&'a str>,
    pub strict: bool,
    pub chunk_count: usize,
    pub row_count: usize,
    pub temp: &'a Path,
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}

fn append_private(path: &Path) -> CognitionResult<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| error("hot_cache_receipt_failed"))
}

fn create_private(path: &Path) -> CognitionResult<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| error("hot_cache_receipt_failed"))
}
