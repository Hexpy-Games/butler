//! Bounded UTF-16 head/tail projection of normalized attachment text.

use std::collections::VecDeque;
use std::io::{Read, Result as IoResult};

use crate::public_text::{is_js_whitespace, trim_js_whitespace_end, trim_js_whitespace_start};

const MARKER: &str = "\n[...attachment content trimmed...]\n";

struct Windows {
    len: usize,
    first: Vec<u16>,
    last: VecDeque<u16>,
    cap: usize,
}

impl Windows {
    fn new(cap: usize) -> Self {
        Self {
            len: 0,
            first: Vec::new(),
            last: VecDeque::new(),
            cap,
        }
    }

    fn clear(&mut self) {
        self.len = 0;
        self.first.clear();
        self.last.clear();
    }

    fn push(&mut self, character: char) {
        for unit in character.encode_utf16(&mut [0; 2]).iter().copied() {
            self.len = self.len.saturating_add(1);
            if self.first.len() < self.cap {
                self.first.push(unit);
            }
            if self.cap > 0 {
                if self.last.len() == self.cap {
                    self.last.pop_front();
                }
                self.last.push_back(unit);
            }
        }
    }

    fn append(&mut self, other: &Self) {
        if self.first.len() < self.cap {
            let remaining = self.cap - self.first.len();
            self.first
                .extend(other.first.iter().copied().take(remaining));
        }
        if other.len >= self.cap {
            self.last.clone_from(&other.last);
        } else {
            for unit in other.last.iter().copied() {
                if self.cap > 0 {
                    if self.last.len() == self.cap {
                        self.last.pop_front();
                    }
                    self.last.push_back(unit);
                }
            }
        }
        self.len = self.len.saturating_add(other.len);
    }
}

pub(super) struct TextCollector {
    complete: Windows,
    trailing_space: Windows,
    started: bool,
    pending_cr: bool,
}

impl TextCollector {
    pub(super) fn new(max_chars: usize) -> Self {
        Self {
            complete: Windows::new(max_chars),
            trailing_space: Windows::new(max_chars),
            started: false,
            pending_cr: false,
        }
    }

    pub(super) fn push(&mut self, character: char) {
        if self.pending_cr {
            self.pending_cr = false;
            if character == '\n' {
                self.accept('\n');
                return;
            }
            self.accept('\r');
        }
        if character == '\r' {
            self.pending_cr = true;
        } else {
            self.accept(character);
        }
    }

    fn accept(&mut self, character: char) {
        if is_js_whitespace(character) {
            if self.started {
                self.trailing_space.push(character);
            }
            return;
        }
        if self.started {
            self.complete.append(&self.trailing_space);
            self.trailing_space.clear();
        }
        self.complete.push(character);
        self.started = true;
    }

    pub(super) fn finish(mut self, max_chars: usize) -> Option<String> {
        if self.pending_cr {
            self.accept('\r');
        }
        if !self.started {
            return None;
        }
        if self.complete.len <= max_chars {
            return Some(String::from_utf16_lossy(&self.complete.first));
        }
        let remaining = max_chars.saturating_sub(MARKER.encode_utf16().count());
        let head_chars = ((remaining as f64) * 0.65).floor() as usize;
        let tail_chars = remaining.saturating_sub(head_chars);
        let head = String::from_utf16_lossy(&self.complete.first[..head_chars]);
        let tail = String::from_utf16_lossy(
            &self
                .complete
                .last
                .iter()
                .rev()
                .take(tail_chars)
                .copied()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
        );
        let mut parts = Vec::with_capacity(3);
        let head = trim_js_whitespace_end(&head);
        if !head.is_empty() {
            parts.push(head);
        }
        parts.push(MARKER.trim());
        let tail = trim_js_whitespace_start(&tail);
        if !tail.is_empty() {
            parts.push(tail);
        }
        Some(parts.join("\n"))
    }
}

pub(super) fn from_text(text: &str, max_chars: usize) -> Option<String> {
    let mut collector = TextCollector::new(max_chars);
    for character in text.chars() {
        collector.push(character);
    }
    collector.finish(max_chars)
}

/// Decode UTF-8 incrementally, matching the replacement behavior of Buffer.toString("utf8").
pub(super) fn from_reader(mut reader: impl Read, max_chars: usize) -> IoResult<Option<String>> {
    let mut collector = TextCollector::new(max_chars);
    let mut bytes = Vec::with_capacity(8196);
    let mut buffer = [0_u8; 8192];
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        let mut consumed = 0;
        while consumed < bytes.len() {
            match std::str::from_utf8(&bytes[consumed..]) {
                Ok(text) => {
                    for character in text.chars() {
                        collector.push(character);
                    }
                    consumed = bytes.len();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    let prefix = std::str::from_utf8(&bytes[consumed..consumed + valid])
                        .expect("valid prefix");
                    for character in prefix.chars() {
                        collector.push(character);
                    }
                    consumed += valid;
                    match error.error_len() {
                        Some(invalid) => {
                            collector.push('\u{fffd}');
                            consumed += invalid;
                        }
                        None => break,
                    }
                }
            }
        }
        bytes.drain(..consumed);
    }
    if !bytes.is_empty() {
        collector.push('\u{fffd}');
    }
    Ok(collector.finish(max_chars))
}
