//! Append-only transcript file authority; App projection follows file bytes.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use super::event::TranscriptEvent;
use super::{TranscriptError, TranscriptResult};
use crate::gateway::TranscriptCode;

pub(super) fn append(
    root: &Path,
    session_id: &str,
    events: &[TranscriptEvent],
) -> TranscriptResult<()> {
    let directory = root.join("transcripts");
    butler_platform::secure_fs::create_private_dir_all(&directory).map_err(io_error)?;
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
    let existed = path.try_exists().map_err(io_error)?;
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    butler_platform::secure_fs::owner_only(&mut options);
    butler_platform::secure_fs::no_follow(&mut options);
    let mut file = options.open(&path).map_err(io_error)?;
    butler_platform::secure_fs::restrict_open_file(&file)
        .unwrap_or(Ok(()))
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_data().map_err(io_error)?;
    if !existed {
        butler_platform::secure_fs::sync_directory(&directory)
            .unwrap_or(Ok(()))
            .map_err(io_error)?;
    }
    if events.len() > 1 {
        butler_platform::secure_fs::fault_checkpoint("transcript_pair").map_err(io_error)?;
    }
    Ok(())
}

fn io_error(error: std::io::Error) -> TranscriptError {
    TranscriptError::new(TranscriptCode::TranscriptAppendFailed, error.to_string())
        .with_source(error)
}
