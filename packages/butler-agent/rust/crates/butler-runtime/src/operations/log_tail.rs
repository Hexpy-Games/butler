//! Follows an append-only JSONL log: each read hands over only the complete
//! lines appended since the previous one.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Bytes compared to recognize a replaced (rotated or rewritten) log.
const HEAD_BYTES: usize = 256;

/// Where the last read of a log stopped.
#[derive(Default)]
pub(crate) struct LogTail {
    offset: u64,
    head: Vec<u8>,
}

impl LogTail {
    /// Calls `reset` when the log is gone, truncated or replaced (the
    /// caller drops what it folded so far, and every line follows), then
    /// `line` with each complete line not handed over before. A row still
    /// being written waits for its newline.
    pub(crate) fn advance<S>(
        &mut self,
        path: &Path,
        state: &mut S,
        reset: impl FnOnce(&mut S),
        mut line: impl FnMut(&mut S, &[u8]),
    ) {
        let Ok(mut file) = File::open(path) else {
            let replaced = self.offset > 0 || !self.head.is_empty();
            *self = Self::default();
            if replaced {
                reset(state);
            }
            return;
        };
        let length = file.metadata().map_or(0, |metadata| metadata.len());
        let head = read_head(&mut file);
        if length < self.offset || head[..self.head.len().min(head.len())] != self.head[..] {
            self.offset = 0;
            reset(state);
        }
        self.head = head;
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut reader = BufReader::with_capacity(256 * 1024, file);
        let mut buffer = Vec::new();
        while let Ok(read) = reader.read_until(b'\n', &mut buffer) {
            if read == 0 || buffer.last() != Some(&b'\n') {
                break;
            }
            self.offset += read as u64;
            line(state, &buffer);
            buffer.clear();
        }
    }
}

fn read_head(file: &mut File) -> Vec<u8> {
    let mut head = Vec::with_capacity(HEAD_BYTES);
    let _ = file.by_ref().take(HEAD_BYTES as u64).read_to_end(&mut head);
    head
}
