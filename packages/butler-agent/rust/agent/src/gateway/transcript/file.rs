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
        .map(|unit| {
            if (unit <= 0x7f && (unit as u8).is_ascii_alphanumeric())
                || [b'.' as u16, b'_' as u16, b'-' as u16].contains(&unit)
            {
                char::from_u32(u32::from(unit)).expect("ASCII unit")
            } else {
                '_'
            }
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
