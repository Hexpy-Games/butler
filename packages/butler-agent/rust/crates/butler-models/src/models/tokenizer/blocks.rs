use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

const BLOCK_BYTES: usize = 8 * 1024;
const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_BLOCKS: usize = 4096;

/// FIFO eviction bounds both retained content/tokens and entry overhead.
/// Keys compare the complete source bytes, never a digest or source identity.
#[derive(Default)]
pub(super) struct BlockCache {
    tokens: HashMap<Arc<str>, Arc<[u32]>>,
    order: VecDeque<Arc<str>>,
    bytes: usize,
}

impl BlockCache {
    pub(super) fn get(&self, text: &str) -> Option<Arc<[u32]>> {
        self.tokens.get(text).cloned()
    }

    pub(super) fn insert(&mut self, text: &str, tokens: Arc<[u32]>) {
        let bytes = text.len() + std::mem::size_of_val(tokens.as_ref());
        if bytes > CACHE_BYTES || self.tokens.contains_key(text) {
            return;
        }
        while self.bytes + bytes > CACHE_BYTES || self.tokens.len() >= CACHE_BLOCKS {
            let Some(key) = self.order.pop_front() else {
                break;
            };
            if let Some(tokens) = self.tokens.remove(&key) {
                self.bytes -= key.len() + std::mem::size_of_val(tokens.as_ref());
            }
        }
        let text: Arc<str> = text.into();
        self.tokens.insert(text.clone(), tokens);
        self.order.push_back(text);
        self.bytes += bytes;
    }
}

pub(super) fn chunks(mut text: &str) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        if text.is_empty() {
            return None;
        }
        let end = boundary(text).unwrap_or(text.len());
        let (chunk, rest) = text.split_at(end);
        text = rest;
        Some(chunk)
    })
}

fn boundary(text: &str) -> Option<usize> {
    // The bundled O200K_BASE_PAT_STR cannot match across an ASCII letter
    // followed by ASCII non-letter, except apostrophe contractions. The letter
    // ends a letter match; the next byte starts a separate regex piece. BPE
    // never merges pieces, so encoding either side is exactly equivalent to
    // encoding the whole string. ASCII also guarantees a UTF-8 boundary.
    // Starting each search at a fixed block size preserves old blocks on append.
    let bytes = text.as_bytes();
    (BLOCK_BYTES..bytes.len()).find(|&at| {
        bytes[at - 1].is_ascii_alphabetic()
            && bytes[at].is_ascii()
            && !bytes[at].is_ascii_alphabetic()
            && bytes[at] != b'\''
    })
}
