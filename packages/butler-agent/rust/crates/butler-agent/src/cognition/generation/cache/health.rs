//! Read-only active hot-cache health using the same physical-entry validator.

use std::{fs, path::Path};

use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use crate::{
    cognition::{MemoryGenerationHandle, graph::GraphRepository},
    conversation::{ConversationSourceReader, conversation_store_path},
};

use super::physical_entries;

pub(in crate::cognition) fn read(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    now: i64,
    expected_revision: i64,
) -> Value {
    let path = handle.root.join("hot/cache.md");
    let content = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return summary(true, None, 0, 0, 0, 0, 0);
        }
        Err(_) => return summary(false, Some("cache_unavailable"), 0, 0, 0, 0, 0),
    };
    let entries = physical_entries(&content);
    let total = entries.len();
    let Ok(graph) = GraphRepository::open_readonly(&handle.graph_path) else {
        return summary(false, Some("cache_unavailable"), total, 0, total, 0, 0);
    };
    let canonical_path = conversation_store_path(data_root);
    let Ok(canonical) = ConversationSourceReader::open(&canonical_path) else {
        let _ = graph.close();
        return summary(false, Some("cache_unavailable"), total, 0, total, 0, 0);
    };
    let as_of = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    let valid = graph.valid_rebuild_cache_entries(
        &handle.generation_id,
        &entries,
        &handle.source_root,
        &canonical,
        &as_of,
    );
    let canonical_closed = canonical.close();
    let graph_closed = graph.close();
    let Ok(valid) = valid else {
        return summary(false, Some("cache_unavailable"), total, 0, total, 0, 0);
    };
    if canonical_closed.is_err() || graph_closed.is_err() {
        return summary(false, Some("cache_unavailable"), total, 0, total, 0, 0);
    }
    let expired = entries
        .iter()
        .filter(|entry| {
            entry
                .get("valid_until")
                .and_then(Value::as_str)
                .and_then(crate::js_date::parse_iso_millis)
                .is_some_and(|at| at <= now)
        })
        .count();
    let current = entries
        .iter()
        .filter(|entry| {
            let id = entry.get("entry_id").and_then(Value::as_str);
            id.is_some_and(|id| valid.contains(id))
                && entry
                    .get("valid_until")
                    .and_then(Value::as_str)
                    .and_then(crate::js_date::parse_iso_millis)
                    .is_none_or(|at| at > now)
        })
        .count();
    let evicted = receipt_evictions(&handle.graph_path);
    let Ok(db) = Connection::open_with_flags(&handle.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return summary(
            false,
            Some("cache_unavailable"),
            total,
            0,
            total - expired,
            expired,
            evicted,
        );
    };
    let revision = db
        .query_row(
            "SELECT value FROM memory_state WHERE key='graph_revision'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| raw.parse::<i64>().ok());
    if revision != Some(expected_revision) {
        return summary(
            false,
            Some("cache_unavailable"),
            total,
            0,
            total - expired,
            expired,
            evicted,
        );
    }
    summary(
        true,
        None,
        total,
        current,
        total.saturating_sub(current + expired),
        expired,
        evicted,
    )
}

fn receipt_evictions(path: &Path) -> usize {
    let Ok(db) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return 0;
    };
    let Ok(mut statement) = db.prepare("SELECT hot_cache_receipt_json FROM memory_projection_jobs WHERE hot_cache_receipt_json IS NOT NULL") else { return 0; };
    let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) else {
        return 0;
    };
    rows.filter_map(Result::ok)
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|receipt| {
            let entries = receipt.get("entries").and_then(Value::as_array);
            entries.map_or_else(
                || excluded(&receipt),
                |items| items.iter().map(excluded).sum(),
            )
        })
        .sum()
}

fn excluded(receipt: &Value) -> usize {
    receipt
        .get("excluded_entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(
                item.get("reason").and_then(Value::as_str),
                Some("budget" | "oversized")
            )
        })
        .count()
}

fn summary(
    available: bool,
    reason: Option<&str>,
    total: usize,
    current: usize,
    stale: usize,
    expired: usize,
    evicted: usize,
) -> Value {
    json!({"available":available,"reason":reason,"total_entries":total,
        "current_entries":current,"stale_entries":stale,
        "expired_entries":expired,"evicted_entries":evicted})
}
