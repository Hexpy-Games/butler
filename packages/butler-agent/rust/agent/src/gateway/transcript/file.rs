//! Append-only transcript file authority; App projection follows file bytes.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use super::event::TranscriptEvent;
use super::{TranscriptError, TranscriptResult};

pub(super) fn append(
    root: &Path,
    session_id: &str,
    events: &[TranscriptEvent],
) -> TranscriptResult<()> {
    let directory = root.join("transcripts");
    fs::create_dir_all(&directory).map_err(io_error)?;
    let name: String = session_id
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') => {
                char::from(byte)
            }
            _ => '_',
        })
        .collect();
    let path = directory.join(format!("{name}.jsonl"));
    for event in events {
        let mut line = serde_json::to_vec(event).map_err(|error| {
            TranscriptError::new("transcript_event_json_invalid", error.to_string())
        })?;
        line.push(b'\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(io_error)?;
        file.write_all(&line).map_err(io_error)?;
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> TranscriptError {
    TranscriptError::new("transcript_append_failed", error.to_string())
}
