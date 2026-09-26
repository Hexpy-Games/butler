//! Bounded transcript record reads with durable large-record spooling.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use super::{TranscriptEvent, checkpoint::Checkpoint};
use crate::gateway::application::storage::AppStorageError;

const BYTE_WINDOW: usize = 64 * 1024;
const ANCHOR_BYTES: u64 = 64;

pub(super) struct ReadRecord {
    pub checkpoint: Checkpoint,
    pub event: Option<TranscriptEvent>,
    pub pending: bool,
    pub completed_spool: Option<PathBuf>,
}

pub(super) fn read_record(
    mut checkpoint: Checkpoint,
    size: u64,
    modified_at_ms: f64,
) -> Result<ReadRecord, AppStorageError> {
    if checkpoint.spool_bytes > 0 {
        return extend_spool(checkpoint, size, modified_at_ms);
    }
    let read_start = checkpoint.projected_bytes + checkpoint.trailing.len() as u64;
    let chunk = read_at(
        &checkpoint.path,
        read_start,
        BYTE_WINDOW.min(size.saturating_sub(read_start) as usize),
    )?;
    let mut combined = std::mem::take(&mut checkpoint.trailing);
    combined.extend_from_slice(&chunk);
    if let Some(newline) = combined.iter().position(|byte| *byte == b'\n') {
        let event = parse_record(&combined[..newline])?;
        checkpoint.projected_bytes += newline as u64 + 1;
        checkpoint.trailing = combined[newline + 1..].to_vec();
        checkpoint.boundary_anchor = anchor(&checkpoint.path, checkpoint.projected_bytes)?;
        checkpoint.modified_at_ms = modified_at_ms;
        let pending = checkpoint.trailing.contains(&b'\n')
            || checkpoint.projected_bytes + (checkpoint.trailing.len() as u64) < size;
        return Ok(ReadRecord {
            checkpoint,
            event,
            pending,
            completed_spool: None,
        });
    }
    checkpoint.modified_at_ms = modified_at_ms;
    if read_start + (chunk.len() as u64) < size {
        let spool = PathBuf::from(&checkpoint.spool_path);
        if let Some(parent) = spool.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::write(&spool, &combined).map_err(io_error)?;
        checkpoint.spool_bytes = combined.len() as u64;
        checkpoint.trailing.clear();
        return Ok(ReadRecord {
            checkpoint,
            event: None,
            pending: true,
            completed_spool: None,
        });
    }
    checkpoint.trailing = combined;
    Ok(ReadRecord {
        checkpoint,
        event: None,
        pending: false,
        completed_spool: None,
    })
}

fn extend_spool(
    mut checkpoint: Checkpoint,
    size: u64,
    modified_at_ms: f64,
) -> Result<ReadRecord, AppStorageError> {
    let start = checkpoint.projected_bytes + checkpoint.spool_bytes;
    let chunk = read_at(
        &checkpoint.path,
        start,
        BYTE_WINDOW.min(size.saturating_sub(start) as usize),
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
        return Ok(ReadRecord {
            pending: start + (chunk.len() as u64) < size,
            checkpoint,
            event: None,
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
    Ok(ReadRecord {
        checkpoint,
        event,
        pending,
        completed_spool: Some(completed),
    })
}

pub(super) fn reusable(
    checkpoint: &Checkpoint,
    path: &Path,
    identity: (u64, u64),
    size: u64,
) -> bool {
    let read_end =
        checkpoint.projected_bytes + checkpoint.spool_bytes + checkpoint.trailing.len() as u64;
    if checkpoint.path != path.to_string_lossy()
        || (checkpoint.device, checkpoint.inode) != identity
        || read_end > size
    {
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
    read_at(path, start, (offset - start) as usize)
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

fn parse_spool(path: &Path) -> Result<Option<TranscriptEvent>, AppStorageError> {
    let file = File::open(path).map_err(io_error)?;
    serde_json::from_reader(file).map(Some).map_err(json_error)
}
fn parse_record(bytes: &[u8]) -> Result<Option<TranscriptEvent>, AppStorageError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| AppStorageError::new("invalid_utf8", error.to_string()))?;
    if text
        .bytes()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
    {
        return Ok(None);
    }
    serde_json::from_str(text).map(Some).map_err(json_error)
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new("invalid_json", error.to_string())
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn io_error(error: std::io::Error) -> AppStorageError {
    AppStorageError::new("app_transcript_io_failed", error.to_string())
}
