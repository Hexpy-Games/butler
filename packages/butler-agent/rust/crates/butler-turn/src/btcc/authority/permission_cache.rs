//! Memoize immutable source decoding, never database rows or listing responses.
use super::contracts::{AuthorityResult, PermissionSource, PermissionTarget};
use butler_core::locale::LocaleCollation;
use std::collections::HashMap;

const MAX_ENTRIES: usize = 4_096;
const MAX_BYTES: usize = 4 * 1_024 * 1_024;
type Prefixes = HashMap<String, HashMap<String, String>>;

#[derive(Default)]
pub(super) struct ProjectionCache {
    entries: HashMap<i64, CachedSource>,
    bytes: usize,
    epoch: u64,
    hits: usize,
    misses: usize,
}
struct CachedSource {
    // Exact current bytes, including owner/workspace and every decoding input.
    facts: [String; 5],
    target: PermissionTarget,
    bytes: usize,
    epoch: u64,
}

impl ProjectionCache {
    pub(super) fn begin(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.hits = 0;
        self.misses = 0;
    }

    pub(super) fn project(
        &mut self,
        source: &PermissionSource<'_>,
        collation: &LocaleCollation,
        prefixes: &mut Prefixes,
    ) -> AuthorityResult<PermissionTarget> {
        let facts = [
            source.owner,
            source.workspace,
            source.capability,
            source.target,
            source.input_json,
        ];
        if let Some(cached) = self.entries.get_mut(&source.rowid)
            && cached
                .facts
                .iter()
                .zip(facts)
                .all(|(old, current)| old == current)
        {
            cached.epoch = self.epoch;
            self.hits += 1;
            return Ok(cached.target.clone());
        }
        if let Some(old) = self.entries.remove(&source.rowid) {
            self.bytes -= old.bytes;
        }
        self.misses += 1;
        let target = super::permission::for_source(source, collation, prefixes)?;
        let bytes = std::mem::size_of::<CachedSource>()
            + facts.iter().map(|value| value.len()).sum::<usize>()
            + target.grant_ref.capacity()
            + target.capability.capacity()
            + target.target.capacity()
            + target.cwd.as_ref().map_or(0, String::capacity);
        if self.entries.len() < MAX_ENTRIES && bytes <= MAX_BYTES.saturating_sub(self.bytes) {
            self.entries.insert(
                source.rowid,
                CachedSource {
                    facts: facts.map(str::to_owned),
                    target: target.clone(),
                    bytes,
                    epoch: self.epoch,
                },
            );
            self.bytes += bytes;
        }
        // Oversized sources still decode and return their complete projection.
        Ok(target)
    }

    pub(super) fn finish(&mut self) {
        self.entries.retain(|_, value| value.epoch == self.epoch);
        self.bytes = self.entries.values().map(|value| value.bytes).sum();
        if std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1") {
            eprintln!(
                "approvals-cache hits={} misses={} entries={} bytes={}",
                self.hits,
                self.misses,
                self.entries.len(),
                self.bytes
            );
        }
    }
}
