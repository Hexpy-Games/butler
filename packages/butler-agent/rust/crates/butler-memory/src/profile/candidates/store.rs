//! Candidate and stable-entry rows: reading and normalizing stored
//! candidates, and writing both tables with the persisted payload layout.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use serde_json::Number;

use super::super::contracts::{ProfileCandidateRecord, ProfileResult, ProfilingMode};
use super::super::storage;
use super::super::understanding::{
    CandidateStatus, Confidence, Expiry, Layer, ObservedTimes, Sensitivity, SourceType,
    StoredUnderstanding, Understanding,
};
use super::policy::{
    category_allowed, hydrate_understanding, identifier, normalize_facet, normalize_text, unique,
};
use crate::lenient::Arg;

pub(super) struct CandidateRow {
    pub id: String,
    pub category: String,
    pub payload: String,
    pub source_type: String,
    pub confidence: String,
    pub sensitive: bool,
    pub created: String,
    pub updated: String,
    pub last_seen: String,
    pub expires: Option<String>,
    pub status: String,
    pub promoted_at: Option<String>,
}

pub(super) fn read_candidate(
    db: &Connection,
    id: &str,
) -> ProfileResult<Option<ProfileCandidateRecord>> {
    db.query_row(
        "SELECT id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status,promoted_at FROM profile_candidates WHERE id=?1 LIMIT 1",
        [id],
        read_record,
    )
    .optional()
    .map_err(storage::db_error)
    .map(|row| row.and_then(hydrate))
}

pub(super) fn pending_rows(db: &Connection) -> ProfileResult<Vec<CandidateRow>> {
    read_rows(db, "WHERE status='candidate' ORDER BY updated_at ASC")
}

pub(super) fn decay_rows(db: &Connection) -> ProfileResult<Vec<CandidateRow>> {
    read_rows(
        db,
        "WHERE status='candidate' AND confidence='low' AND expires_or_decay='decay'",
    )
}

fn read_rows(db: &Connection, tail: &str) -> ProfileResult<Vec<CandidateRow>> {
    let sql = format!(
        "SELECT id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status,promoted_at FROM profile_candidates {tail}"
    );
    let mut statement = db.prepare(&sql).map_err(storage::db_error)?;
    statement
        .query_map([], read_record)
        .map_err(storage::db_error)?
        .map(|row| row.map_err(storage::db_error))
        .collect()
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<CandidateRow> {
    Ok(CandidateRow {
        id: row.get(0)?,
        category: row.get(1)?,
        payload: row.get(2)?,
        source_type: row.get(3)?,
        confidence: row.get(4)?,
        sensitive: row.get::<_, i64>(5)? == 1,
        created: row.get(6)?,
        updated: row.get(7)?,
        last_seen: row.get(8)?,
        expires: row.get(9)?,
        status: row.get(10)?,
        promoted_at: row.get(11)?,
    })
}

/// Reads a stored candidate, normalizing every field the way consolidation
/// expects; `None` for a disallowed category or an empty summary.
pub(super) fn hydrate(row: CandidateRow) -> Option<ProfileCandidateRecord> {
    if !category_allowed(&row.category, ProfilingMode::Deep) {
        return None;
    }
    let stored = StoredUnderstanding::parse(&row.payload).unwrap_or_default();
    let summary = normalize_text(stored.summary.valid()?, 320);
    if summary.is_empty() {
        return None;
    }
    let facet = normalize_facet(stored.facet_text()).map(str::to_owned);
    let shape = hydrate_understanding(
        &stored,
        &row.category,
        facet.as_deref(),
        &summary,
        row.sensitive,
    );
    let evidence_refs = unique(
        stored
            .evidence_refs
            .iter()
            .map(|value| normalize_text(value, 160))
            .filter(|value| !value.is_empty())
            .collect(),
    );
    let evidence_count = stored_count(stored.evidence_count.as_ref(), evidence_refs.len());
    Some(ProfileCandidateRecord {
        id: row.id,
        layer: shape.layer,
        category: row.category,
        understanding: Understanding {
            facet,
            summary,
            applies_when: shape.applies_when,
            butler_should: shape.butler_should,
            butler_should_not: shape.butler_should_not,
            temporal_scope: shape.temporal_scope,
            decay_policy: shape.decay_policy,
            contradiction_refs: shape.contradiction_refs,
            sensitivity: shape.sensitivity,
            evidence_refs,
            evidence_observed_at: normalized_times(stored.evidence_observed_at),
            evidence_count,
        },
        source_type: SourceType::parse(&row.source_type).unwrap_or(SourceType::Inference),
        confidence: Confidence::parse(&row.confidence).unwrap_or(Confidence::Low),
        sensitive_domain: row.sensitive,
        status: CandidateStatus::parse(&row.status).unwrap_or(CandidateStatus::Candidate),
        created_at: row.created,
        updated_at: row.updated,
        last_seen_at: row.last_seen,
        expires_or_decay: row.expires.as_deref().and_then(Expiry::parse),
        promoted_at: row.promoted_at,
    })
}

/// The stored count (a finite number, at least the number of refs); whole
/// counts are written as integers.
fn stored_count(stored: Option<&Number>, refs: usize) -> Number {
    let count = stored
        .and_then(Number::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .max(refs as f64);
    if count.fract() == 0.0 && count <= u64::MAX as f64 {
        Number::from(butler_core::json::saturating_u64(count))
    } else {
        Number::from_f64(count).unwrap_or_else(|| Number::from(0))
    }
}

/// Observation times keyed by normalized ref, each an ISO time with
/// milliseconds or `null`.
fn normalized_times(stored: ObservedTimes) -> ObservedTimes {
    let mut times = ObservedTimes::new();
    for (reference, time) in stored {
        let reference = normalize_text(&reference, 160);
        if reference.is_empty() {
            continue;
        }
        let time = time
            .valid()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map_or(Arg::Null, |value| {
                Arg::Valid(
                    value
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )
            });
        times.insert(reference, time);
    }
    times
}

/// A `payload_json` as stored: the layer, the shared understanding, and for
/// stable entries whether it touches a sensitive domain.
#[derive(Serialize)]
struct PersistedPayload<'a> {
    layer: Layer,
    #[serde(flatten)]
    understanding: &'a Understanding,
    #[serde(skip_serializing_if = "Option::is_none")]
    sensitive_domain: Option<bool>,
}

impl PersistedPayload<'_> {
    fn text(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "null".into())
    }
}

/// Inserts or updates the candidate row.
pub(super) fn write_candidate(
    db: &Connection,
    candidate: &ProfileCandidateRecord,
) -> ProfileResult<()> {
    let payload = PersistedPayload {
        layer: candidate.layer,
        understanding: &candidate.understanding,
        sensitive_domain: None,
    };
    db.execute("INSERT INTO profile_candidates(id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status,promoted_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)ON CONFLICT(id)DO UPDATE SET category=excluded.category,payload_json=excluded.payload_json,source_type=excluded.source_type,confidence=excluded.confidence,sensitive_domain=excluded.sensitive_domain,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,expires_or_decay=excluded.expires_or_decay,status=excluded.status,promoted_at=excluded.promoted_at",params![candidate.id,candidate.category,payload.text(),candidate.source_type.as_str(),candidate.confidence.as_str(),i64::from(candidate.sensitive_domain),candidate.created_at,candidate.updated_at,candidate.last_seen_at,candidate.expires_or_decay.map(Expiry::as_str),candidate.status.as_str(),candidate.promoted_at]).map_err(storage::db_error)?;
    Ok(())
}

/// A promoted candidate as it is written to the stable profile.
pub(super) struct StableWrite<'a> {
    id: String,
    candidate: &'a ProfileCandidateRecord,
    now: &'a str,
}

impl<'a> StableWrite<'a> {
    /// The stable entry for `candidate`, written at `now`.
    pub(super) fn of(candidate: &'a ProfileCandidateRecord, now: &'a str) -> Self {
        Self {
            id: identifier(
                "sp_",
                &candidate.category,
                candidate.understanding.facet.as_deref(),
                &candidate.understanding.summary,
            ),
            candidate,
            now,
        }
    }
}

/// Inserts the stable entry, or merges it into the stored one: lists and
/// observation times accumulate, and confidence, source and sensitivity
/// only grow.
pub(super) fn write_stable(db: &Connection, entry: &StableWrite<'_>) -> ProfileResult<()> {
    let candidate = entry.candidate;
    let existing = db
        .query_row(
            "SELECT payload_json,confidence,source_type,created_at FROM stable_profile_entries WHERE id=?1 LIMIT 1",
            [&entry.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        )
        .optional()
        .map_err(storage::db_error)?;
    let mut understanding = candidate.understanding.clone();
    let mut confidence = candidate.confidence.as_str().to_owned();
    let mut source = candidate.source_type.as_str().to_owned();
    let mut created = entry.now.to_owned();
    if let Some((raw, old_confidence, old_source, old_created)) = existing {
        let previous = StoredUnderstanding::parse(&raw).unwrap_or_default();
        merge_stable(&mut understanding, &previous);
        confidence = stronger(
            old_confidence,
            candidate.confidence,
            Confidence::Low,
            Confidence::parse,
        );
        source = stronger(
            old_source,
            candidate.source_type,
            SourceType::Inference,
            SourceType::parse,
        );
        created = old_created;
    }
    let payload = PersistedPayload {
        layer: candidate.layer,
        understanding: &understanding,
        sensitive_domain: Some(candidate.sensitive_domain),
    };
    db.execute("INSERT INTO stable_profile_entries(id,category,payload_json,confidence,source_type,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7)ON CONFLICT(id)DO UPDATE SET category=excluded.category,payload_json=excluded.payload_json,confidence=excluded.confidence,source_type=excluded.source_type,updated_at=excluded.updated_at",params![entry.id,candidate.category,payload.text(),confidence,source,created,entry.now]).map_err(storage::db_error)?;
    Ok(())
}

/// The stronger of a stored column value and a new one. A stored value that
/// is not a known name ranks with the weakest and wins ties.
fn stronger<T: Copy + Ord + Into<&'static str>>(
    stored: String,
    new: T,
    weakest: T,
    parse: fn(&str) -> Option<T>,
) -> String {
    match parse(&stored) {
        Some(old) if old >= new => stored,
        None if new == weakest => stored,
        _ => new.into().to_owned(),
    }
}

/// Folds the stored stable payload into the new one.
fn merge_stable(current: &mut Understanding, previous: &StoredUnderstanding) {
    let merged = |previous: &[String], current: &[String], limit: usize| {
        unique([previous, current].concat())
            .into_iter()
            .take(limit)
            .collect::<Vec<_>>()
    };
    current.evidence_refs = merged(&previous.evidence_refs, &current.evidence_refs, 24);
    current.applies_when = merged(&previous.applies_when, &current.applies_when, 6);
    current.butler_should = merged(&previous.butler_should, &current.butler_should, 6);
    current.butler_should_not = merged(&previous.butler_should_not, &current.butler_should_not, 6);
    current.contradiction_refs =
        merged(&previous.contradiction_refs, &current.contradiction_refs, 6);
    let mut observed = previous.evidence_observed_at.clone();
    for (reference, time) in &current.evidence_observed_at {
        observed.insert(reference.clone(), time.clone());
    }
    current.evidence_observed_at = observed;
    let count = |value: Option<&Number>| value.and_then(Number::as_u64).unwrap_or(0);
    current.evidence_count = Number::from(
        count(previous.evidence_count.as_ref()).max(count(Some(&current.evidence_count))),
    );
    current.sensitivity = previous
        .sensitivity
        .unwrap_or(Sensitivity::Normal)
        .max(current.sensitivity);
}
