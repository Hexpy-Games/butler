//! Which stable entries may shape the runtime projection: entries whose
//! evidence still exists in the user's own messages (or a verified import),
//! that have not decayed, and that no explicit correction replaced.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;

use super::super::contracts::{
    CanonicalProfileSourceFactory, ProfileError, ProfileResult, ProfilingMode,
};
use super::super::storage::{self, StoredEntry};
use super::super::understanding::{DecayPolicy, StoredUnderstanding, TemporalScope};
use crate::lenient::{self, Arg};

pub(super) fn eligible_sources(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    entries: Vec<StoredEntry>,
    mode: ProfilingMode,
    now_ms: i64,
) -> ProfileResult<Vec<StoredEntry>> {
    let db = if refs_required(&entries) {
        Some(storage::open(data_root, storage::Access::Read)?)
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
                    current.contains(reference)
                        || verified_import(data_root, reference, &entry.id)
                        || sources
                            .verified_feedback(reference, &entry.id)
                            .unwrap_or(false)
                })
                .collect::<Vec<_>>();
            if valid.is_empty() {
                return None;
            }
            let understanding = &mut entry.understanding;
            understanding.evidence_observed_at = valid
                .iter()
                .map(|key| {
                    let time = understanding.evidence_observed_at.get(key).cloned();
                    (key.clone(), time.unwrap_or(Arg::Null))
                })
                .collect();
            understanding.evidence_refs = valid;
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
            let understanding = &entry.understanding;
            if mode == ProfilingMode::Basic && understanding.sensitive_domain.unwrap_or(false) {
                return false;
            }
            let latest = understanding
                .evidence_observed_at
                .values()
                .filter_map(Arg::valid)
                .filter_map(|value| parse_time(value))
                .max();
            let Some(latest) = latest else {
                return understanding.temporal_scope == Some(TemporalScope::Durable)
                    && matches!(
                        understanding.decay_policy,
                        Some(DecayPolicy::ReinforceOrDecay | DecayPolicy::NeverWithoutConsent)
                    );
            };
            let age = now_ms.saturating_sub(latest);
            match understanding.decay_policy {
                Some(DecayPolicy::Days7) => age <= 7 * 86_400_000,
                Some(DecayPolicy::Days30) => age <= 30 * 86_400_000,
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
        for target in &correction.understanding.contradiction_refs {
            let Some(existing) = by_id.get(target.as_str()) else {
                continue;
            };
            if existing.category == correction.category
                && existing.understanding.facet_text() == correction.understanding.facet_text()
                && normalized_conditions(&existing.understanding)
                    == normalized_conditions(&correction.understanding)
            {
                contradicted.insert(target.clone());
            }
        }
    }
    source_eligible
        .into_iter()
        .filter(|entry| !contradicted.contains(&entry.id))
        .collect()
}

fn normalized_conditions(understanding: &StoredUnderstanding) -> Vec<String> {
    let mut values = understanding
        .applies_when
        .iter()
        .map(|value| super::super::naming::collapse_js_whitespace(value))
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    values.dedup();
    values
}

fn evidence_refs(entry: &StoredEntry) -> Vec<String> {
    entry.understanding.evidence_refs.clone()
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
    let manifest: ImportManifest = lenient::view(&value);
    let candidate = id.strip_prefix("sp_").map(|tail| format!("pc_{tail}"));
    manifest.import_id.as_deref() == Some(reference)
        && manifest.source.as_deref() == Some(source)
        && manifest.text_sha256.as_deref() == Some(digest)
        && manifest.raw_text_included == Some(false)
        && manifest
            .candidate_ids
            .iter()
            .any(|value| value == id || candidate.as_ref() == Some(value))
}

/// The fields of a third-party import manifest that vouch for an entry.
#[derive(Default, Deserialize)]
#[serde(default)]
struct ImportManifest {
    #[serde(deserialize_with = "lenient::option")]
    import_id: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    source: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    text_sha256: Option<String>,
    #[serde(deserialize_with = "lenient::option")]
    raw_text_included: Option<bool>,
    #[serde(deserialize_with = "lenient::string_list")]
    candidate_ids: Vec<String>,
}
