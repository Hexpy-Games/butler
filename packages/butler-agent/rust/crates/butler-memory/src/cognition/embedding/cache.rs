//! A bounded cache of embedding vectors keyed by the text they embed.

use std::collections::{HashMap, VecDeque};

use sha2::{Digest, Sha256};

/// Vectors kept: 4096 x 1024 f32 is 16 MB.
const CAPACITY: usize = 4096;

/// What identifies a vector: how it was pooled and the SHA-256 of its text.
/// One engine has one model and tokenizer, so the pooling mode is all that
/// distinguishes its embedding identities.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub(super) struct Key {
    checked: bool,
    text: [u8; 32],
}

impl Key {
    pub(super) fn new(checked: bool, text: &str) -> Self {
        Self {
            checked,
            text: Sha256::digest(text.as_bytes()).into(),
        }
    }
}

/// Oldest-first eviction: the texts embedded most recently are the ones a
/// repeated request is most likely to embed again.
#[derive(Default)]
pub(super) struct VectorCache {
    vectors: HashMap<Key, Vec<f32>>,
    order: VecDeque<Key>,
}

impl VectorCache {
    pub(super) fn get(&self, key: &Key) -> Option<&Vec<f32>> {
        self.vectors.get(key)
    }

    pub(super) fn insert(&mut self, key: Key, vector: Vec<f32>) {
        if self.vectors.insert(key, vector).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.vectors.remove(&oldest);
            }
        }
    }
}
