//! Append-only transcript file authority; App projection follows file bytes.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use super::event::TranscriptEvent;
use super::{TranscriptError, TranscriptResult};
use crate::gateway::TranscriptCode;

pub(super) fn append(
    root: &Path,
    session_id: &str,
    events: &[TranscriptEvent],
) -> TranscriptResult<String> {
    let directory = root.join("transcripts");
    fs::create_dir_all(&directory).map_err(io_error)?;
    let mut name: String = session_id
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') => {
                char::from(byte)
            }
            _ => '_',
        })
        .collect();
    name.push_str(".jsonl");
    let path = directory.join(&name);
    let mut bytes = Vec::new();
    for event in events {
        serde_json::to_writer(&mut bytes, event).map_err(|error| {
            TranscriptError::new(
                TranscriptCode::TranscriptEventJsonInvalid,
                error.to_string(),
            )
            .with_source(error)
        })?;
        bytes.push(b'\n');
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    if events.len() > 1 {
        butler_platform::secure_fs::fault_checkpoint("transcript_pair").map_err(io_error)?;
    }
    Ok(name)
}

fn io_error(error: std::io::Error) -> TranscriptError {
    TranscriptError::new(TranscriptCode::TranscriptAppendFailed, error.to_string())
        .with_source(error)
}
