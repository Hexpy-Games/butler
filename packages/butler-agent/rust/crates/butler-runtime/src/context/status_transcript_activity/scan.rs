//! Scans one transcript for tool and delivery activity. Only lines that can
//! hold activity are parsed, and a scan may resume where a previous one
//! stopped.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::LazyLock,
};

use regex::bytes::Regex;

use super::{ActivityAccumulator, MAX_JSONL_LINE_BYTES, apply_activity_line};
use crate::context::status_conversation::TranscriptScanError;

/// Bytes read at a time.
const CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// A line holds activity only if it names a tool event or reports `ok:false`
/// (a failed delivery). Without the pattern every line is parsed.
static ACTIVITY: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"tool_call|tool_result|"ok"\s*:\s*false"#).ok());

/// Folds the complete lines from `offset` on into `activity`; returns the
/// offset just past the last complete line. A line still being written (no
/// newline yet) and a line over the size cap are not folded, and the scan
/// resumes before an unfinished one.
pub(super) fn scan_from(
    path: &Path,
    offset: u64,
    activity: &mut ActivityAccumulator,
) -> Result<u64, TranscriptScanError> {
    let mut file = File::open(path).map_err(TranscriptScanError::read)?;
    file.seek(SeekFrom::Start(offset))
        .map_err(TranscriptScanError::read)?;
    let mut buffer = Vec::new();
    // File offset of `buffer[0]`, and of the first byte not yet consumed.
    let mut base = offset;
    let mut consumed = offset;
    let mut skipping = false;
    loop {
        let before = buffer.len();
        let read = file
            .by_ref()
            .take(CHUNK_BYTES as u64)
            .read_to_end(&mut buffer)
            .map_err(TranscriptScanError::read)?;
        if read == 0 {
            return Ok(consumed);
        }
        if skipping {
            let Some(newline) = buffer[before..].iter().position(|byte| *byte == b'\n') else {
                base += buffer.len() as u64;
                buffer.clear();
                continue;
            };
            let end = before + newline + 1;
            buffer.drain(..end);
            base += end as u64;
            consumed = base;
            skipping = false;
        }
        let Some(last) = buffer.iter().rposition(|byte| *byte == b'\n') else {
            if buffer.len() > MAX_JSONL_LINE_BYTES {
                skipping = true;
                base += buffer.len() as u64;
                buffer.clear();
            }
            continue;
        };
        scan_lines(&buffer[..=last], activity);
        buffer.drain(..=last);
        base += (last + 1) as u64;
        consumed = base;
    }
}

/// `block` is whole lines, each ending in a newline.
fn scan_lines(block: &[u8], activity: &mut ActivityAccumulator) {
    let Some(filter) = ACTIVITY.as_ref() else {
        for line in block.split(|byte| *byte == b'\n') {
            apply_capped(activity, line);
        }
        return;
    };
    let mut handled = 0;
    for hit in filter.find_iter(block) {
        if hit.start() < handled {
            continue;
        }
        let start = block[..hit.start()]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |index| index + 1);
        let end = block[hit.end()..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(block.len(), |index| hit.end() + index);
        handled = end + 1;
        apply_capped(activity, &block[start..end]);
    }
}

fn apply_capped(activity: &mut ActivityAccumulator, line: &[u8]) {
    if line.len() <= MAX_JSONL_LINE_BYTES {
        apply_activity_line(activity, line);
    }
}
