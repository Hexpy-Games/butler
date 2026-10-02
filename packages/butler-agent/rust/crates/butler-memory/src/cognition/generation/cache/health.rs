//! Read-only active hot-cache health using the same physical-entry validator.

use butler_platform::sqlite;
use std::{collections::HashSet, fs, path::Path};

use rusqlite::OpenFlags;
use serde::Serialize;

use crate::cognition::MemoryGenerationHandle;
use crate::cognition::graph::GraphRepository;
use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};

use super::{HotCacheEntryView, physical_entries, receipt::JobReceiptView};

/// Health of the serving generation's hot cache.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(in crate::cognition) struct HotCacheHealth {
    pub available: bool,
    pub reason: Option<&'static str>,
    pub total_entries: usize,
    pub current_entries: usize,
    pub stale_entries: usize,
    pub expired_entries: usize,
    pub evicted_entries: usize,
}

impl HotCacheHealth {
    /// No cache file: healthy and empty.
    fn empty() -> Self {
        Self {
            available: true,
            reason: None,
            total_entries: 0,
            current_entries: 0,
            stale_entries: 0,
            expired_entries: 0,
            evicted_entries: 0,
        }
    }

    /// No cache could be read: every entry counts as stale.
    pub(in crate::cognition) fn unavailable(reason: &'static str, total: usize) -> Self {
        Self {
            available: false,
            reason: Some(reason),
            total_entries: total,
            current_entries: 0,
            stale_entries: total,
            expired_entries: 0,
            evicted_entries: 0,
        }
    }
}

/// Validates every physical entry against the graph and canonical sources.
pub(in crate::cognition) fn read(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    now: i64,
    expected_revision: i64,
) -> HotCacheHealth {
    let content = match fs::read_to_string(handle.root.join("hot/cache.md")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return HotCacheHealth::empty();
        }
        Err(_) => return HotCacheHealth::unavailable("cache_unavailable", 0),
    };
    let entries = physical_entries(&content);
    let total = entries.len();
    let Some(valid) = validate(data_root, handle, &entries, now) else {
        return HotCacheHealth::unavailable("cache_unavailable", total);
    };
    let expired_at = |entry: &HotCacheEntryView| {
        entry
            .valid_until
            .as_deref()
            .and_then(butler_core::js_date::parse_iso_millis)
    };
    let expired = entries
        .iter()
        .filter(|entry| expired_at(entry).is_some_and(|at| at <= now))
        .count();
    let current = entries
        .iter()
        .filter(|entry| {
            entry
                .entry_id
                .as_deref()
                .is_some_and(|id| valid.contains(id))
                && expired_at(entry).is_none_or(|at| at > now)
        })
        .count();
    let evicted = receipt_evictions(&handle.graph_path);
    let counted = |available, reason, current, stale| HotCacheHealth {
        available,
        reason,
        total_entries: total,
        current_entries: current,
        stale_entries: stale,
        expired_entries: expired,
        evicted_entries: evicted,
    };
    if graph_revision(&handle.graph_path) != Some(expected_revision) {
        return counted(false, Some("cache_unavailable"), 0, total - expired);
    }
    counted(true, None, current, total.saturating_sub(current + expired))
}

/// The ids of entries with current evidence, or `None` when the graph or
/// canonical store cannot be read.
fn validate(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    entries: &[HotCacheEntryView],
    now: i64,
) -> Option<HashSet<String>> {
    let graph = GraphRepository::open_readonly(&handle.graph_path).ok()?;
    let Ok(canonical) = ConversationSourceReader::open(&conversation_store_path(data_root)) else {
        let _ = graph.close();
        return None;
    };
    let as_of = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    let valid = graph.valid_rebuild_cache_entries(
        &handle.generation_id,
        entries,
        &handle.source_root,
        &canonical,
        &as_of,
    );
    let canonical_closed = canonical.close();
    let graph_closed = graph.close();
    let valid = valid.ok()?;
    (canonical_closed.is_ok() && graph_closed.is_ok()).then_some(valid)
}

fn graph_revision(path: &Path) -> Option<i64> {
    let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.query_row(
        "SELECT value FROM memory_state WHERE key='graph_revision'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| raw.parse::<i64>().ok())
}

/// Entries receipts report as evicted for size or budget.
fn receipt_evictions(path: &Path) -> usize {
    let Ok(db) = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return 0;
    };
    let Ok(mut statement) = db.prepare(
        "SELECT hot_cache_receipt_json FROM memory_projection_jobs \
         WHERE hot_cache_receipt_json IS NOT NULL",
    ) else {
        return 0;
    };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return 0;
    };
    rows.filter_map(Result::ok)
        .filter_map(|raw| JobReceiptView::parse(&raw))
        .map(|receipt| match &receipt.entries {
            Some(entries) => entries
                .iter()
                .flatten()
                .map(|entry| evicted(entry.excluded_entries.as_deref()))
                .sum(),
            None => evicted(receipt.excluded_entries.as_deref()),
        })
        .sum()
}

fn evicted(excluded: Option<&[Option<super::receipt::ExcludedEntryView>]>) -> usize {
    excluded
        .into_iter()
        .flatten()
        .flatten()
        .filter(|item| item.evicted_for_space())
        .count()
}
