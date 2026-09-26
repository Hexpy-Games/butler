use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::Connection;
use serde_json::Value;

use super::super::contracts::{
    CanonicalProfileSourceFactory, ProfileError, ProfileResult, ProfilingMode,
};
use super::super::storage::{self, StoredEntry};
pub(super) fn eligible_sources(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    entries: Vec<StoredEntry>,
    mode: ProfilingMode,
    now_ms: i64,
) -> ProfileResult<Vec<StoredEntry>> {
    let db = if refs_required(&entries) {
        Some(storage::open(data_root, false)?)
    } else {
        None
    };
    eligible_sources_in_db(data_root, sources, db.as_ref(), entries, mode, now_ms)
}

pub(super) fn eligible_sources_in_db(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    db: Option<&Connection>,
    entries: Vec<StoredEntry>,
    mode: ProfilingMode,
    now_ms: i64,
) -> ProfileResult<Vec<StoredEntry>> {
    let refs = entries
        .iter()
        .flat_map(evidence_refs)
        .collect::<HashSet<_>>();
    let rows = coverage_rows(db, &refs)?;
    let mut current = HashSet::new();
    let mut reader = sources.open()?;
    let read_result = (|| {
        let mut messages = HashMap::new();
        for row in rows {
            if !messages.contains_key(&row.message_id) {
                messages.insert(
                    row.message_id.clone(),
                    reader.read_message(&row.message_id)?,
                );
            }
            let Some(message) = messages.get(&row.message_id).and_then(Option::as_ref) else {
                continue;
            };
            if message.role != "user" || message.origin_kind != "user_input" {
                continue;
            }
            let scalar = message
                .parts
                .iter()
                .find(|part| part.part_id == row.part_id)
                .and_then(|part| {
                    part.scalars.iter().find(|scalar| {
                        scalar.pointer == row.pointer && scalar.source_hash == row.source_hash
                    })
                });
            let Some(scalar) = scalar else { continue };
            if row.byte_start < 0.0 || row.byte_end > scalar.text.len() as f64 {
                continue;
            }
            current.insert(row.evidence_ref);
        }
        Ok::<(), ProfileError>(())
    })();
    let close_result = reader.close();
    close_result?;
    read_result?;
    let entries = entries
        .into_iter()
        .filter_map(|mut entry| {
            let valid = evidence_refs(&entry)
                .into_iter()
                .filter(|reference| {
                    current.contains(reference) || verified_import(data_root, reference, &entry.id)
                })
                .collect::<Vec<_>>();
            if valid.is_empty() {
                return None;
            }
            if let Some(payload) = entry.payload.as_object_mut() {
                payload.insert(
                    "evidence_refs".into(),
                    Value::Array(valid.iter().cloned().map(Value::String).collect()),
                );
                let observed = payload
                    .get("evidence_observed_at")
                    .and_then(Value::as_object);
                payload.insert(
                    "evidence_observed_at".into(),
                    Value::Object(
                        valid
                            .iter()
                            .map(|key| {
                                (
                                    key.clone(),
                                    observed
                                        .and_then(|values| values.get(key))
                                        .cloned()
                                        .unwrap_or(Value::Null),
                                )
                            })
                            .collect(),
                    ),
                );
            }
            Some(entry)
        })
        .collect::<Vec<_>>();
    Ok(eligible_policy(entries, mode, now_ms))
}

struct CoverageRow {
    evidence_ref: String,
    message_id: String,
    source_hash: String,
    part_id: String,
    pointer: String,
    byte_start: f64,
    byte_end: f64,
}

fn refs_required(entries: &[StoredEntry]) -> bool {
    entries.iter().any(|entry| !evidence_refs(entry).is_empty())
}

fn coverage_rows(
    db: Option<&Connection>,
    refs: &HashSet<String>,
) -> ProfileResult<Vec<CoverageRow>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let Some(db) = db else {
        return Ok(Vec::new());
    };
    let mut statement = db
        .prepare(
            "SELECT evidence_ref,message_id,source_hash,part_id,scalar_pointer,byte_start,byte_end
         FROM profile_source_coverage WHERE disposition='complete'",
        )
        .map_err(storage::db_error)?;
    statement
        .query_map([], |row| {
            Ok(CoverageRow {
                evidence_ref: row.get(0)?,
                message_id: row.get(1)?,
                source_hash: row.get(2)?,
                part_id: row.get(3)?,
                pointer: row.get(4)?,
                byte_start: row.get(5)?,
                byte_end: row.get(6)?,
            })
        })
        .map_err(storage::db_error)?
        .filter_map(|row| match row {
            Ok(row) if refs.contains(&row.evidence_ref) => Some(Ok(row)),
            Ok(_) => None,
            Err(error) => Some(Err(storage::db_error(error))),
        })
        .collect()
}

fn eligible_policy(
    entries: Vec<StoredEntry>,
    mode: ProfilingMode,
    now_ms: i64,
) -> Vec<StoredEntry> {
    let source_eligible = entries
        .into_iter()
        .filter(|entry| {
            if !category_allowed(&entry.category, mode) {
                return false;
            }
            if mode == ProfilingMode::Basic && bool_field(&entry.payload, "sensitive_domain") {
                return false;
            }
            let observed = entry
                .payload
                .get("evidence_observed_at")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter_map(|(_, value)| value.as_str())
                .filter_map(parse_time)
                .collect::<Vec<_>>();
            if observed.is_empty() {
                return text(&entry.payload, "temporal_scope") == Some("durable")
                    && matches!(
                        text(&entry.payload, "decay_policy"),
                        Some("reinforce_or_decay" | "never_without_consent")
                    );
            }
            let age = now_ms.saturating_sub(observed.into_iter().max().unwrap());
            match text(&entry.payload, "decay_policy") {
                Some("days_7") => age <= 7 * 86_400_000,
                Some("days_30") => age <= 30 * 86_400_000,
                _ => true,
            }
        })
        .collect::<Vec<_>>();
    let by_id = source_eligible
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let mut contradicted = HashSet::new();
    for correction in &source_eligible {
        if !matches!(
            correction.source_type.as_str(),
            "explicit" | "user_confirmed"
        ) {
            continue;
        }
        for target in strings(&correction.payload, "contradiction_refs") {
            let Some(existing) = by_id.get(target.as_str()) else {
                continue;
            };
            if existing.category == correction.category
                && text(&existing.payload, "facet") == text(&correction.payload, "facet")
                && normalized_conditions(&existing.payload)
                    == normalized_conditions(&correction.payload)
            {
                contradicted.insert(target);
            }
        }
    }
    source_eligible
        .into_iter()
        .filter(|entry| !contradicted.contains(&entry.id))
        .collect()
}

fn normalized_conditions(value: &Value) -> Vec<String> {
    let mut values = strings(value, "applies_when")
        .into_iter()
        .map(|value| super::super::naming::collapse_js_whitespace(&value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    values.dedup();
    values
}

fn evidence_refs(entry: &StoredEntry) -> Vec<String> {
    strings(&entry.payload, "evidence_refs")
}
fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn category_allowed(category: &str, mode: ProfilingMode) -> bool {
    mode == ProfilingMode::Deep
        || mode == ProfilingMode::Basic
            && matches!(category, "communication" | "epistemic_style" | "boundaries")
}
fn parse_time(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.timestamp_millis())
}
fn verified_import(root: &Path, reference: &str, id: &str) -> bool {
    let Some((source, digest)) = reference
        .strip_prefix("third_party_profile_import:")
        .and_then(|value| value.split_once(':'))
        .filter(|(source, digest)| {
            !source.is_empty()
                && source.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte)
                })
                && digest.len() == 16
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
    else {
        return false;
    };
    let Ok(bytes) = fs::read(
        root.join("personalization/profile-imports")
            .join(format!("{digest}.json")),
    ) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value.get("import_id").and_then(Value::as_str) == Some(reference)
        && value.get("source").and_then(Value::as_str) == Some(source)
        && value.get("text_sha256").and_then(Value::as_str) == Some(digest)
        && value.get("raw_text_included").and_then(Value::as_bool) == Some(false)
        && value
            .get("candidate_ids")
            .and_then(Value::as_array)
            .is_some_and(|ids| {
                ids.iter().any(|value| {
                    value.as_str() == Some(id)
                        || id
                            .strip_prefix("sp_")
                            .is_some_and(|tail| value.as_str() == Some(&format!("pc_{tail}")))
                })
            })
}
