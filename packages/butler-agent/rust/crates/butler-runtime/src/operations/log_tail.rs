//! Follows an append-only JSONL log: each read hands over only the complete
//! lines appended since the previous one.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Bytes compared to recognize a replaced (rotated or rewritten) log.
const HEAD_BYTES: usize = 256;

/// Where the last read of a log stopped.
#[derive(Default)]
pub struct LogTail {
    offset: u64,
    head: Vec<u8>,
    tail: Vec<u8>,
    signature: Option<Signature>,
}

#[derive(Clone, Copy)]
struct Signature {
    id: Option<butler_platform::secure_fs::FileId>,
    created: Option<butler_platform::secure_fs::FileTime>,
    length: u64,
    modified: Option<std::time::SystemTime>,
}

impl LogTail {
    /// Calls `reset` when the log is gone, truncated or replaced (the
    /// caller drops what it folded so far, and every line follows), then
    /// `line` with each complete line not handed over before. A row still
    /// being written waits for its newline.
    pub fn advance<S>(
        &mut self,
        path: &Path,
        state: &mut S,
        reset: impl FnOnce(&mut S),
        line: impl FnMut(&mut S, &[u8]),
    ) {
        self.advance_rows(path, state, reset, line, false);
    }

    /// Visits valid JSON rows, including a complete trailing value without a newline.
    /// Its cursor still waits at the trailing row so a subsequent append is revalidated.
    pub fn advance_json<S>(
        &mut self,
        path: &Path,
        state: &mut S,
        reset: impl FnOnce(&mut S),
        mut visit: impl FnMut(&mut S, &serde_json::Value),
    ) {
        self.advance_rows(
            path,
            state,
            reset,
            |state, line| {
                let line = line.strip_suffix(b"\n").unwrap_or(line);
                if line.len() <= butler_core::json_lines::MAX_JSON_LINE_BYTES
                    && let Ok(value) = serde_json::from_slice(line)
                {
                    visit(state, &value);
                }
            },
            true,
        );
    }

    fn advance_rows<S>(
        &mut self,
        path: &Path,
        state: &mut S,
        reset: impl FnOnce(&mut S),
        mut line: impl FnMut(&mut S, &[u8]),
        trailing: bool,
    ) {
        let Ok(mut file) = File::open(path) else {
            let replaced = self.offset > 0 || !self.head.is_empty();
            *self = Self::default();
            if replaced {
                reset(state);
            }
            return;
        };
        let metadata = file.metadata().ok();
        let length = metadata.as_ref().map_or(0, std::fs::Metadata::len);
        let signature = metadata.as_ref().map(|metadata| {
            let identity = butler_platform::secure_fs::identity(metadata);
            Signature {
                id: identity.id,
                created: identity.id.is_none().then_some(identity.changed).flatten(),
                length,
                modified: metadata.modified().ok(),
            }
        });
        let replaced = self.signature.zip(signature).is_some_and(|(old, new)| {
            old.id != new.id
                || old.created != new.created
                || new.length < old.length
                || (old.length == new.length && old.modified != new.modified)
        });
        let head = read_head(&mut file);
        let tail = read_tail(&mut file, length);
        let rewritten = self.signature.is_some_and(|old| {
            old.length <= length
                && if old.length == length {
                    self.tail != tail
                } else {
                    self.tail != read_tail(&mut file, old.length)
                }
        });
        if replaced
            || rewritten
            || length < self.offset
            || head[..self.head.len().min(head.len())] != self.head[..]
        {
            self.offset = 0;
            reset(state);
        }
        self.head = head;
        self.tail = tail;
        self.signature = signature;
        // Identity and both content anchors were checked above. An exact EOF
        // has no rows to fold; avoid allocating and zeroing a 256KiB reader on
        // every unchanged status request. Partial trailing JSON still revisits
        // its row because its offset remains strictly below the file length.
        if self.offset == length {
            return;
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        // A short append needs only its own buffer. Retain the large buffer for
        // initial indexing, and keep reading to EOF even if the file grows
        // after its metadata was observed.
        let capacity = length.saturating_sub(self.offset).clamp(1, 256 * 1024) as usize;
        let mut reader = BufReader::with_capacity(capacity, file);
        read_rows(&mut reader, &mut self.offset, state, &mut line, trailing);
    }
}

fn read_rows<S>(
    reader: &mut impl BufRead,
    offset: &mut u64,
    state: &mut S,
    line: &mut impl FnMut(&mut S, &[u8]),
    trailing: bool,
) {
    let mut buffer = Vec::new();
    let mut row_bytes = 0_u64;
    let mut oversized = false;
    while let Ok(chunk) = reader.fill_buf() {
        if chunk.is_empty() {
            if trailing && !oversized && !buffer.is_empty() {
                line(state, &buffer);
            }
            break;
        }
        let end = chunk
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(chunk.len(), |index| index + 1);
        let ended = chunk[end - 1] == b'\n';
        row_bytes += end as u64;
        if !oversized {
            if trailing
                && buffer.len().saturating_add(end) > butler_core::json_lines::MAX_JSON_LINE_BYTES
            {
                oversized = true;
                buffer.clear();
            } else {
                buffer.extend_from_slice(&chunk[..end]);
            }
        }
        reader.consume(end);
        if ended {
            *offset += row_bytes;
            if !oversized {
                line(state, &buffer);
            }
            buffer.clear();
            row_bytes = 0;
            oversized = false;
        }
    }
}

fn read_head(file: &mut File) -> Vec<u8> {
    let mut head = Vec::with_capacity(HEAD_BYTES);
    let _ = file.by_ref().take(HEAD_BYTES as u64).read_to_end(&mut head);
    head
}

/// Compare the bounded end of the previously read content as well as its head.
/// An appended row must not hide a rewrite of the preceding latest row.
fn read_tail(file: &mut File, length: u64) -> Vec<u8> {
    if file
        .seek(SeekFrom::Start(length.saturating_sub(HEAD_BYTES as u64)))
        .is_err()
    {
        return Vec::new();
    }
    let mut tail = Vec::with_capacity(HEAD_BYTES);
    let _ = file.by_ref().take(HEAD_BYTES as u64).read_to_end(&mut tail);
    tail
}
