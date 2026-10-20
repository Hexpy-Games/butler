//! Bounded lookup of uploaded bytes already durable in this file owner.
//! Every upload retains its private ID path and metadata. Atomic replacement
//! detaches a mutable path without changing earlier uploads of the same bytes.
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::Read,
    path::Path,
};

const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_ITEMS: usize = 256;

struct Entry {
    storage: String,
    size: usize,
}

#[derive(Default)]
pub(super) struct Cache {
    items: HashMap<String, Entry>,
    order: VecDeque<String>,
    bytes: usize,
}

impl Cache {
    pub(super) fn reuse(&mut self, root: &Path, hash: &str, id: &str, bytes: &[u8]) -> bool {
        let Some(entry) = self.items.get(hash) else {
            return false;
        };
        let source = root.join(&entry.storage);
        // A digest selects a candidate, never establishes equality. Bounded
        // rereads also detect a removed or externally modified backing file.
        if !same_bytes(&source, bytes) {
            self.remove(hash);
            return false;
        }
        // The payload is already durable. Persist this upload's own directory
        // entry; filesystems without hard links use ordinary uploads instead.
        butler_platform::secure_fs::link_private(&source, &root.join(id)).is_ok()
    }

    pub(super) fn remember(&mut self, hash: String, storage: String, size: usize) {
        self.remove(&hash);
        if size > CACHE_BYTES {
            return;
        }
        while self.bytes + size > CACHE_BYTES || self.items.len() >= CACHE_ITEMS {
            let Some(old) = self.order.front().cloned() else {
                break;
            };
            self.remove(&old);
        }
        self.bytes += size;
        self.order.push_back(hash.clone());
        self.items.insert(hash, Entry { storage, size });
    }

    pub(super) fn replacing(&mut self, hash: &str, storage: &str) {
        if self
            .items
            .get(hash)
            .is_some_and(|entry| entry.storage == storage)
        {
            self.remove(hash);
        }
    }

    fn remove(&mut self, hash: &str) {
        if let Some(entry) = self.items.remove(hash) {
            self.bytes -= entry.size;
            self.order.retain(|key| key != hash);
        }
    }
}

fn same_bytes(path: &Path, expected: &[u8]) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    if !metadata.is_file() || metadata.len() != expected.len() as u64 {
        return false;
    }
    let mut bytes = Vec::with_capacity(expected.len());
    file.take(expected.len() as u64 + 1)
        .read_to_end(&mut bytes)
        .is_ok()
        && bytes == expected
}

#[cfg(test)]
#[path = "upload_cache_tests.rs"]
mod tests;
