//! Lane-owned bounded continuation LRU. No polling or persistent cache.
use super::{
    super::{StorageResult, common::stringify},
    delta::{Delta, Op},
};
use serde_json::Value;
use std::collections::VecDeque;

pub(in crate::btcc::storage) struct Entry {
    pub turn_id: String,
    pub checkpoint_id: String,
    pub checkpoint_revision: u64,
    pub acceptance_id: String,
    pub items: Vec<Value>,
    pub serialized: Vec<String>,
    pub approx_bytes: usize,
    pub chain_len: usize,
}
impl Entry {
    pub(super) fn matches(&self, turn: &str, checkpoint: &str, revision: u64) -> bool {
        self.turn_id == turn
            && self.checkpoint_id == checkpoint
            && self.checkpoint_revision == revision
    }
}
#[derive(Default)]
pub(in crate::btcc::storage) struct ContinuationMemo {
    entries: VecDeque<Entry>,
}
impl ContinuationMemo {
    pub(super) fn base(&self, turn: &str, checkpoint: &str, revision: u64) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|e| e.matches(turn, checkpoint, revision))
    }
    pub(super) fn get(&self, acceptance: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.acceptance_id == acceptance)
    }
    pub(super) fn take(&mut self, acceptance: &str) -> Option<Entry> {
        let index = self
            .entries
            .iter()
            .position(|e| e.acceptance_id == acceptance)?;
        self.entries.remove(index)
    }
    pub(super) fn evict(&mut self, turn: &str) {
        self.entries.retain(|e| e.turn_id != turn);
    }
    pub(super) fn put(&mut self, entry: Entry) {
        const BYTES: usize = 64 * 1024 * 1024;
        self.evict(&entry.turn_id);
        if entry.approx_bytes > BYTES {
            return;
        }
        while self.entries.len() >= 8
            || self.entries.iter().map(|e| e.approx_bytes).sum::<usize>() + entry.approx_bytes
                > BYTES
        {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }
}

// Passthrough: the byte carrier uses the same serializer as persisted continuations.
pub(super) fn item_strings(items: &[Value]) -> StorageResult<Vec<String>> {
    items.iter().map(stringify).collect()
}

// Passthrough: keep the memo's serialized carrier in sync using only literal work.
pub(super) fn apply_serialized_validated(
    items: &mut Vec<String>,
    delta: &Delta,
) -> StorageResult<()> {
    let mut output = 0;
    for op in &delta.ops {
        match op {
            Op::Copy(op) => output += op.c[1],
            Op::Literal(op) => {
                for value in &op.l {
                    let raw = stringify(value)?;
                    if let Some(slot) = items.get_mut(output) {
                        *slot = raw;
                    } else {
                        items.push(raw);
                    }
                    output += 1;
                }
            }
        }
    }
    items.truncate(output);
    Ok(())
}
