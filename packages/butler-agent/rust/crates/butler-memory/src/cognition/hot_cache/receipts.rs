//! Legacy indexing receipts written after the vector rows, even if graph extraction warns.

use crate::cognition::CognitionCode;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::cognition::{CognitionError, CognitionResult, ensure_data_authority};

use super::legacy_graph;

/// Records the receipt of an indexed hot-cache block.
pub(super) fn record(
    data_root: &Path,
    memory_root: &Path,
    text: &str,
    session_id: &str,
    chunk_count: usize,
    row_count: usize,
    temp: &Path,
) -> CognitionResult<()> {
    write(
        LegacyReceiptInput {
            data_root,
            memory_root,
            text,
            session_id,
            source_session_id: session_id,
            project: "butler",
            source: "hot-cache",
            topic: None,
            strict: false,
            chunk_count,
            row_count,
            temp,
        },
        Codes {
            clock: CognitionCode::HotCacheClockUnavailable,
            receipt: CognitionCode::HotCacheReceiptFailed,
        },
    )
}

/// Records the receipt of an indexed legacy session.
pub(super) fn record_legacy(input: LegacyReceiptInput<'_>) -> CognitionResult<()> {
    write(
        input,
        Codes {
            clock: CognitionCode::LegacySessionClockUnavailable,
            receipt: CognitionCode::LegacySessionReceiptFailed,
        },
    )
}

/// The failure codes of one receipt writer.
#[derive(Clone, Copy)]
struct Codes {
    clock: CognitionCode,
    receipt: CognitionCode,
}

/// One `session-provenance.jsonl` line.
#[derive(Serialize)]
struct ProvenanceLine<'a> {
    session_id: &'a str,
    source_session_id: &'a str,
    project: &'a str,
    source: &'a str,
    topic: Option<&'a str>,
    source_message_ids: [&'a str; 0],
    indexed_at: &'a str,
    chunk_count: usize,
}

/// `vector-stats.json` after an index write.
#[derive(Serialize)]
struct VectorStats<'a> {
    table: &'static str,
    row_count: usize,
    updated_at: &'a str,
    last_session_id: &'a str,
    last_source_session_id: &'a str,
    last_source_message_ids: [&'a str; 0],
    last_chunk_count: usize,
}

/// Extracts the legacy graph (a failure only warns unless `strict`), then
/// appends the provenance line, replaces the vector stats and logs the
/// index.
fn write(input: LegacyReceiptInput<'_>, codes: Codes) -> CognitionResult<()> {
    let LegacyReceiptInput {
        data_root,
        memory_root,
        session_id,
        source_session_id,
        project,
        chunk_count,
        row_count,
        temp,
        ..
    } = input;
    let failed = |source| error(codes.receipt).with_source(source);
    let db = memory_root.join("db");
    let provenance = db.join("session-provenance.jsonl");
    let stats = db.join("vector-stats.json");
    let log = data_root.join("logs/memory.log");
    ensure_data_authority(
        data_root,
        &[memory_root, &db, &provenance, &stats, temp, &log],
    )?;
    extract_graph(input, codes)?;
    let indexed_at = DateTime::<Utc>::from(std::time::SystemTime::now())
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    fs::create_dir_all(&db).map_err(failed)?;
    let mut receipt = append_private(&provenance)?;
    let line = ProvenanceLine {
        session_id,
        source_session_id,
        project,
        source: input.source,
        topic: input.topic,
        source_message_ids: [],
        indexed_at: &indexed_at,
        chunk_count,
    };
    writeln!(
        receipt,
        "{}",
        serde_json::to_string(&line).map_err(|source| error(codes.receipt).with_source(source))?
    )
    .map_err(failed)?;
    let serialized = serde_json::to_vec_pretty(&VectorStats {
        table: "butler_memory",
        row_count,
        updated_at: &indexed_at,
        last_session_id: session_id,
        last_source_session_id: source_session_id,
        last_source_message_ids: [],
        last_chunk_count: chunk_count,
    })
    .map_err(|source| error(codes.receipt).with_source(source))?;
    replace_stats(temp, &stats, &serialized, codes)?;
    let parent = log.parent().ok_or_else(|| error(codes.receipt))?;
    fs::create_dir_all(parent).map_err(failed)?;
    let mut output = append_private(&log)?;
    writeln!(
        output,
        "[{}] index.ts | project={project} session={session_id} | chunks={chunk_count}",
        indexed_at.replace('T', " ").get(..19).unwrap_or("")
    )
    .map_err(failed)?;
    Ok(())
}

fn extract_graph(input: LegacyReceiptInput<'_>, codes: Codes) -> CognitionResult<()> {
    let graph_seconds = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|source| error(codes.clock).with_source(source))?
            .as_secs(),
    )
    .unwrap_or(i64::MAX);
    let graph = legacy_graph::extract_and_save(
        input.data_root,
        input.memory_root,
        input.text,
        input.session_id,
        input.project,
        Some(input.source),
        graph_seconds,
    );
    if let Err(error) = graph {
        let code = error.code();
        if input.strict {
            return Err(
                CognitionError::new(CognitionCode::LegacySessionGraphFailed, code)
                    .with_source(error),
            );
        }
        eprintln!("Warning: graph extraction failed ({code})");
    }
    Ok(())
}

/// Replaces `vector-stats.json` through `temp`, keeping its permissions.
fn replace_stats(
    temp: &Path,
    stats: &Path,
    serialized: &[u8],
    codes: Codes,
) -> CognitionResult<()> {
    let failed = |source| error(codes.receipt).with_source(source);
    let result: CognitionResult<()> = (|| {
        let mut output = create_private(temp)?;
        if let Ok(metadata) = fs::metadata(stats) {
            fs::set_permissions(temp, metadata.permissions()).map_err(failed)?;
        }
        output
            .write_all(serialized)
            .and_then(|()| output.write_all(b"\n"))
            .and_then(|()| output.sync_all())
            .map_err(failed)?;
        fs::rename(temp, stats).map_err(failed)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
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

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}

fn append_private(path: &Path) -> CognitionResult<std::fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    butler_platform::secure_fs::owner_only(&mut options);
    options
        .open(path)
        .map_err(|source| error(CognitionCode::HotCacheReceiptFailed).with_source(source))
}

fn create_private(path: &Path) -> CognitionResult<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    butler_platform::secure_fs::owner_only(&mut options);
    options
        .open(path)
        .map_err(|source| error(CognitionCode::HotCacheReceiptFailed).with_source(source))
}
