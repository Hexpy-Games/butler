//! Bounded transcript record reads with durable large-record spooling.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use super::{TranscriptEvent, checkpoint::Checkpoint};
use crate::gateway::application::storage::{AppStorageCode, AppStorageError};

const BYTE_WINDOW: usize = 64 * 1024;
const ANCHOR_BYTES: u64 = 64;

/// One complete transcript record and the byte offset just past it.
pub(super) struct Record {
    pub event: TranscriptEvent,
    pub end: u64,
    pub anchor: Vec<u8>,
}

/// The complete records of one byte window. `checkpoint` describes the file
/// position after the last of them.
pub(super) struct ReadBatch {
    pub checkpoint: Checkpoint,
    pub records: Vec<Record>,
    pub pending: bool,
    pub completed_spool: Option<PathBuf>,
}

/// Reads every complete record of one byte window. A window is read only when
/// `trailing` holds no complete record, so `trailing` stays within one window
/// plus one partial record.
pub(super) fn read_batch(
    mut checkpoint: Checkpoint,
    size: u64,
    modified_at_ms: f64,
) -> Result<ReadBatch, AppStorageError> {
    if checkpoint.spool_bytes > 0 {
        return extend_spool(checkpoint, size, modified_at_ms);
    }
    let mut buffer = std::mem::take(&mut checkpoint.trailing);
    let mut read_end = checkpoint.projected_bytes + buffer.len() as u64;
    if !buffer.contains(&b'\n') {
        let wanted = usize::try_from(size.saturating_sub(read_end)).unwrap_or(usize::MAX);
        let chunk = read_at(&checkpoint.path, read_end, BYTE_WINDOW.min(wanted))?;
        read_end += chunk.len() as u64;
        buffer.extend_from_slice(&chunk);
    }
    checkpoint.modified_at_ms = modified_at_ms;
    let (records, consumed, boundary_anchor) = split_records(&buffer, &checkpoint)?;
    if consumed == 0 && read_end < size {
        // A record longer than the window continues in a spool file.
        let spool = PathBuf::from(&checkpoint.spool_path);
        if let Some(parent) = spool.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::write(&spool, &buffer).map_err(io_error)?;
        checkpoint.spool_bytes = buffer.len() as u64;
        return Ok(ReadBatch {
            checkpoint,
            records: Vec::new(),
            pending: true,
            completed_spool: None,
        });
    }
    checkpoint.boundary_anchor = boundary_anchor;
    checkpoint.projected_bytes += consumed as u64;
    checkpoint.trailing = buffer.split_off(consumed);
    let pending = checkpoint.trailing.contains(&b'\n')
        || checkpoint.projected_bytes + (checkpoint.trailing.len() as u64) < size;
    Ok(ReadBatch {
        checkpoint,
        records,
        pending,
        completed_spool: None,
    })
}

/// Splits the complete records off the front of `buffer`, returning them, the
/// bytes they span and the anchor at their end. A malformed record
/// ends the batch so the records before it are still projected; it fails the
/// next read, where it comes first.
fn split_records(
    buffer: &[u8],
    checkpoint: &Checkpoint,
) -> Result<(Vec<Record>, usize, Vec<u8>), AppStorageError> {
    let mut records = Vec::new();
    let mut consumed = 0;
    let mut anchor_bytes = checkpoint.boundary_anchor.clone();
    while let Some(length) = buffer[consumed..].iter().position(|byte| *byte == b'\n') {
        let line = &buffer[consumed..consumed + length];
        let event = match parse_record(line) {
            Ok(event) => event,
            Err(error) if consumed == 0 => return Err(error),
            Err(_) => break,
        };
        consumed += length + 1;
        anchor_bytes = anchor_after(&anchor_bytes, &buffer[consumed - length - 1..consumed]);
        if let Some(event) = event {
            records.push(Record {
                event,
                end: checkpoint.projected_bytes + consumed as u64,
                anchor: anchor_bytes.clone(),
            });
        }
    }
    Ok((records, consumed, anchor_bytes))
}

/// The last `ANCHOR_BYTES` of `before` followed by `added`.
fn anchor_after(before: &[u8], added: &[u8]) -> Vec<u8> {
    let keep = usize::try_from(ANCHOR_BYTES).unwrap_or(usize::MAX);
    let from_added = added.len().saturating_sub(keep);
    let from_before = (keep - (added.len() - from_added)).min(before.len());
    let mut bytes = before[before.len() - from_before..].to_vec();
    bytes.extend_from_slice(&added[from_added..]);
    bytes
}

fn extend_spool(
    mut checkpoint: Checkpoint,
    size: u64,
    modified_at_ms: f64,
) -> Result<ReadBatch, AppStorageError> {
    let start = checkpoint.projected_bytes + checkpoint.spool_bytes;
    let chunk = read_at(
        &checkpoint.path,
        start,
        BYTE_WINDOW.min(usize::try_from(size.saturating_sub(start)).unwrap_or(usize::MAX)),
    )?;
    let newline = chunk.iter().position(|byte| *byte == b'\n');
    let record = newline.map_or(chunk.as_slice(), |at| &chunk[..at]);
    let mut spool = OpenOptions::new()
        .append(true)
        .open(&checkpoint.spool_path)
        .map_err(io_error)?;
    spool.write_all(record).map_err(io_error)?;
    checkpoint.spool_bytes += record.len() as u64;
    checkpoint.modified_at_ms = modified_at_ms;
    let Some(newline) = newline else {
        return Ok(ReadBatch {
            pending: start + (chunk.len() as u64) < size,
            checkpoint,
            records: Vec::new(),
            completed_spool: None,
        });
    };
    let completed = PathBuf::from(&checkpoint.spool_path);
    let event = parse_spool(&completed)?;
    checkpoint.projected_bytes = start + newline as u64 + 1;
    checkpoint.trailing = chunk[newline + 1..].to_vec();
    checkpoint.boundary_anchor = anchor(&checkpoint.path, checkpoint.projected_bytes)?;
    checkpoint.spool_path.clear();
    checkpoint.spool_bytes = 0;
    checkpoint.spool_end_offset = 0;
    let pending = checkpoint.trailing.contains(&b'\n')
        || checkpoint.projected_bytes + (checkpoint.trailing.len() as u64) < size;
    let record = Record {
        event,
        end: checkpoint.projected_bytes,
        anchor: checkpoint.boundary_anchor.clone(),
    };
    Ok(ReadBatch {
        checkpoint,
        records: vec![record],
        pending,
        completed_spool: Some(completed),
    })
}

/// Whether `checkpoint` still describes the start of `path`. The file is
/// recognised by its path, its size and the bytes just before the recorded
/// offset. Device and inode numbers are not compared: they change across
/// reboots and volumes for a file that is untouched, and a checkpoint judged
/// foreign for that reason projects a finished transcript from byte zero.
pub(super) fn reusable(checkpoint: &Checkpoint, path: &Path, size: u64) -> bool {
    let read_end =
        checkpoint.projected_bytes + checkpoint.spool_bytes + checkpoint.trailing.len() as u64;
    if checkpoint.path != path.to_string_lossy() || read_end > size {
        return false;
    }
    anchor(path, checkpoint.projected_bytes).is_ok_and(|value| value == checkpoint.boundary_anchor)
        && (checkpoint.spool_bytes == 0 || spool_matches(checkpoint))
}

fn spool_matches(checkpoint: &Checkpoint) -> bool {
    let spool = anchor(&checkpoint.spool_path, checkpoint.spool_bytes);
    let length = checkpoint.spool_bytes.min(ANCHOR_BYTES);
    let source = read_at(
        &checkpoint.path,
        checkpoint.projected_bytes + checkpoint.spool_bytes - length,
        length as usize,
    );
    spool.is_ok() && spool == source
}

pub(super) fn anchor(path: impl AsRef<Path>, offset: u64) -> Result<Vec<u8>, AppStorageError> {
    let start = offset.saturating_sub(ANCHOR_BYTES);
    read_at(
        path,
        start,
        usize::try_from(offset - start).unwrap_or(usize::MAX),
    )
}

fn read_at(path: impl AsRef<Path>, start: u64, length: usize) -> Result<Vec<u8>, AppStorageError> {
    if length == 0 {
        return Ok(Vec::new());
    }
    let mut file = File::open(path).map_err(io_error)?;
    file.seek(SeekFrom::Start(start)).map_err(io_error)?;
    let mut bytes = vec![0; length];
    let count = file.read(&mut bytes).map_err(io_error)?;
    bytes.truncate(count);
    Ok(bytes)
}

fn parse_spool(path: &Path) -> Result<TranscriptEvent, AppStorageError> {
    let file = File::open(path).map_err(io_error)?;
    serde_json::from_reader(file).map_err(json_error)
}
fn parse_record(bytes: &[u8]) -> Result<Option<TranscriptEvent>, AppStorageError> {
    let text = std::str::from_utf8(bytes).map_err(|error| {
        AppStorageError::new(AppStorageCode::InvalidUtf8, error.to_string()).with_source(error)
    })?;
    if text
        .bytes()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
    {
        return Ok(None);
    }
    serde_json::from_str(text).map(Some).map_err(json_error)
}
fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new(AppStorageCode::InvalidJson, error.to_string()).with_source(error)
}
fn io_error(error: std::io::Error) -> AppStorageError {
    AppStorageError::new(AppStorageCode::AppTranscriptIoFailed, error.to_string())
        .with_source(error)
}
