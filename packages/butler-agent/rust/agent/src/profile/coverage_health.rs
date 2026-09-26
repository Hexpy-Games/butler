//! Read-only source coverage health, with canonical source currentness checks.

use std::path::Path;

use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use super::{contracts::CanonicalProfileSourceFactory, storage};

struct CoverageRow {
    disposition: String,
    failure_code: Option<String>,
    message_id: String,
    part_id: String,
    pointer: String,
    source_hash: String,
    byte_start: i64,
    byte_end: i64,
}

pub(super) fn read(data_root: &Path, sources: &dyn CanonicalProfileSourceFactory) -> Value {
    if !storage::database_path(data_root).exists() {
        return unavailable("profile_store_unavailable");
    }
    read_open(data_root, sources).unwrap_or_else(|| unavailable("profile_coverage_unavailable"))
}

fn read_open(data_root: &Path, sources: &dyn CanonicalProfileSourceFactory) -> Option<Value> {
    let db = storage::open(data_root, false).ok()?;
    let consent = storage::read_consent(data_root);
    let mut statement = db.prepare("SELECT disposition,failure_code,message_id,part_id,scalar_pointer,source_hash,byte_start,byte_end FROM profile_source_coverage").ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok(CoverageRow {
                disposition: row.get(0)?,
                failure_code: row.get(1)?,
                message_id: row.get(2)?,
                part_id: row.get(3)?,
                pointer: row.get(4)?,
                source_hash: row.get(5)?,
                byte_start: row.get(6)?,
                byte_end: row.get(7)?,
            })
        })
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let mut reader = sources.open().ok()?;
    let mut counts = [0_usize; 5];
    let mut read_ok = true;
    for row in rows {
        if row.disposition == "complete" {
            counts[4] += 1;
        }
        let Ok(message) = reader.read_message(&row.message_id) else {
            read_ok = false;
            break;
        };
        let scalar = message
            .as_ref()
            .filter(|message| message.role == "user" && message.origin_kind == "user_input")
            .and_then(|message| {
                message
                    .parts
                    .iter()
                    .find(|part| part.part_id == row.part_id)
            })
            .and_then(|part| {
                part.scalars.iter().find(|scalar| {
                    scalar.pointer == row.pointer && scalar.source_hash == row.source_hash
                })
            });
        let current = scalar.is_some_and(|scalar| {
            row.byte_start >= 0
                && row.byte_end > row.byte_start
                && row.byte_end <= i64::try_from(scalar.text.len()).unwrap_or(i64::MAX)
        });
        if row.failure_code.as_deref() == Some("source_stale") || !current {
            counts[3] += 1;
        } else if consent.mode != super::ProfilingMode::Off {
            match row.disposition.as_str() {
                "complete" => counts[0] += 1,
                "pending" => counts[1] += 1,
                "failed" => counts[2] += 1,
                _ => {}
            }
        }
    }
    let closed = reader.close();
    if !read_ok || closed.is_err() {
        return None;
    }
    let offset = db
        .query_row(
            "SELECT value_json FROM profile_meta WHERE key='source_scan_offset'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.as_i64());
    let discovery = offset.filter(|value| *value > 0).map(|_| true);
    Some(
        json!({"available":true,"reason":null,"consent_mode":consent.mode.as_str(),
        "processed_windows":counts[0],"pending_windows":counts[1],"failed_windows":counts[2],
        "stale_history_windows":counts[3],"historical_processed_windows":counts[4],
        "discovery_incomplete":discovery,
        "discovery_reason":if discovery.is_some(){None}else{Some("discovery_not_observed")}}),
    )
}

fn unavailable(reason: &str) -> Value {
    json!({"available":false,"reason":reason,"consent_mode":"off",
        "processed_windows":0,"pending_windows":0,"failed_windows":0,
        "stale_history_windows":0,"historical_processed_windows":0,
        "discovery_incomplete":null,"discovery_reason":"discovery_not_observed"})
}
