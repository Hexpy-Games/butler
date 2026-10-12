//! Bounded LRU with indexed hits and accounting; no request-path cache scans.
use std::collections::{BTreeMap, HashMap};
const CAPACITY: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub(super) struct Derivatives {
    entries: HashMap<String, Entry>,
    ages: BTreeMap<u64, String>,
    bytes: usize,
    clock: u64,
}
struct Entry {
    bytes: Vec<u8>,
    age: u64,
}
impl Derivatives {
    pub(super) fn get(&mut self, key: &str) -> Option<Vec<u8>> {
        let entry = self.entries.get_mut(key)?;
        self.ages.remove(&entry.age);
        self.clock = self.clock.wrapping_add(1);
        entry.age = self.clock;
        self.ages.insert(entry.age, key.to_owned());
        Some(entry.bytes.clone())
    }
    pub(super) fn insert(&mut self, key: String, bytes: Vec<u8>) {
        if let Some(old) = self.entries.remove(&key) {
            self.ages.remove(&old.age);
            self.bytes -= old.bytes.len();
        }
        if bytes.len() > CAPACITY {
            return;
        }
        while self.bytes + bytes.len() > CAPACITY {
            let Some((_, oldest)) = self.ages.pop_first() else {
                break;
            };
            if let Some(old) = self.entries.remove(&oldest) {
                self.bytes -= old.bytes.len();
            }
        }
        self.clock = self.clock.wrapping_add(1);
        self.bytes += bytes.len();
        self.ages.insert(self.clock, key.clone());
        self.entries.insert(
            key,
            Entry {
                bytes,
                age: self.clock,
            },
        );
    }
    pub(super) fn clear(&mut self) {
        self.entries.clear();
        self.ages.clear();
        self.bytes = 0;
        self.clock = 0;
    }
}
