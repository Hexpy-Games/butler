use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use super::super::contracts::{ProfileCandidateRecord, ProfileResult};
use super::super::storage;
use super::policy::{
    hydrate_understanding, normalize_facet, normalize_text, strings, stronger, unique,
};

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

pub(super) fn hydrate(row: CandidateRow) -> Option<ProfileCandidateRecord> {
    if !super::policy::category_allowed(&row.category, super::super::contracts::ProfilingMode::Deep)
    {
        return None;
    }
    let mut payload = serde_json::from_str::<Value>(&row.payload)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let summary = normalize_text(payload.get("summary")?.as_str()?, 320);
    if summary.is_empty() {
        return None;
    }
    payload.insert("id".into(), Value::String(row.id.clone()));
    payload.insert("category".into(), Value::String(row.category.clone()));
    payload.insert("summary".into(), Value::String(summary));
    payload.insert(
        "facet".into(),
        normalize_facet(payload.get("facet").and_then(Value::as_str))
            .map(|value| Value::String(value.to_owned()))
            .unwrap_or(Value::Null),
    );
    hydrate_understanding(&mut payload, &row.category, row.sensitive);
    let refs = unique(
        strings(&Value::Object(payload.clone()), "evidence_refs")
            .into_iter()
            .map(|value| normalize_text(&value, 160))
            .filter(|value| !value.is_empty())
            .collect(),
    );
    let evidence_count = payload
        .get("evidence_count")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
        .max(refs.len() as f64);
    payload.insert(
        "evidence_refs".into(),
        Value::Array(refs.into_iter().map(Value::String).collect()),
    );
    payload.insert(
        "evidence_count".into(),
        if evidence_count.fract() == 0.0 && evidence_count <= u64::MAX as f64 {
            Value::from(evidence_count as u64)
        } else {
            Value::from(evidence_count)
        },
    );
    let observed = payload
        .get("evidence_observed_at")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut normalized_observed = serde_json::Map::new();
    for (reference, value) in observed {
        let reference = normalize_text(&reference, 160);
        if reference.is_empty() {
            continue;
        }
        let timestamp = value
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| {
                Value::String(
                    value
                        .with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                )
            })
            .unwrap_or(Value::Null);
        normalized_observed.insert(reference, timestamp);
    }
    payload.insert(
        "evidence_observed_at".into(),
        Value::Object(normalized_observed),
    );
    let source = match row.source_type.as_str() {
        "explicit" | "repeated_observation" | "user_confirmed" => row.source_type,
        _ => "inference".into(),
    };
    let confidence = match row.confidence.as_str() {
        "medium" | "high" => row.confidence,
        _ => "low".into(),
    };
    let status = match row.status.as_str() {
        "promoted" | "rejected" | "expired" => row.status,
        _ => "candidate".into(),
    };
    for (key, value) in [
        ("source_type", source),
        ("confidence", confidence),
        ("status", status),
        ("created_at", row.created),
        ("updated_at", row.updated),
        ("last_seen_at", row.last_seen),
    ] {
        payload.insert(key.into(), Value::String(value));
    }
    payload.insert("sensitive_domain".into(), Value::Bool(row.sensitive));
    payload.insert(
        "expires_or_decay".into(),
        row.expires
            .filter(|value| matches!(value.as_str(), "expires" | "decay"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "promoted_at".into(),
        row.promoted_at.map(Value::String).unwrap_or(Value::Null),
    );
    Some(ProfileCandidateRecord {
        id: row.id,
        payload: Value::Object(payload),
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn write_candidate(
    db: &Connection,
    id: &str,
    category: &str,
    source: &str,
    confidence: &str,
    sensitive: bool,
    created: &str,
    updated: &str,
    last: &str,
    expires: Option<&str>,
    status: &str,
    payload: &Value,
) -> ProfileResult<()> {
    let stored_payload = persisted_payload(payload, false);
    db.execute("INSERT INTO profile_candidates(id,category,payload_json,source_type,confidence,sensitive_domain,created_at,updated_at,last_seen_at,expires_or_decay,status,promoted_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)ON CONFLICT(id)DO UPDATE SET category=excluded.category,payload_json=excluded.payload_json,source_type=excluded.source_type,confidence=excluded.confidence,sensitive_domain=excluded.sensitive_domain,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,expires_or_decay=excluded.expires_or_decay,status=excluded.status,promoted_at=excluded.promoted_at",params![id,category,serde_json::to_string(&stored_payload).unwrap_or("null".into()),source,confidence,i64::from(sensitive),created,updated,last,expires,status,payload.get("promoted_at").and_then(Value::as_str)]).map_err(storage::db_error)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn write_stable(
    db: &Connection,
    id: &str,
    category: &str,
    confidence: &str,
    source: &str,
    created: &str,
    updated: &str,
    payload: &Value,
) -> ProfileResult<()> {
    let existing = db
        .query_row(
            "SELECT payload_json,confidence,source_type,created_at FROM stable_profile_entries WHERE id=?1 LIMIT 1",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        )
        .optional()
        .map_err(storage::db_error)?;
    let mut merged = payload.clone();
    let mut merged_confidence = confidence;
    let mut merged_source = source;
    let mut merged_created = created;
    if let Some((raw, old_confidence, old_source, old_created)) = &existing {
        let previous: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        merge_stable_payload(&mut merged, &previous);
        merged_confidence = stronger(Some(old_confidence), confidence, &["low", "medium", "high"]);
        merged_source = stronger(
            Some(old_source),
            source,
            &[
                "inference",
                "repeated_observation",
                "explicit",
                "user_confirmed",
            ],
        );
        merged_created = old_created;
    }
    let stored_payload = persisted_payload(&merged, true);
    db.execute("INSERT INTO stable_profile_entries(id,category,payload_json,confidence,source_type,created_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7)ON CONFLICT(id)DO UPDATE SET category=excluded.category,payload_json=excluded.payload_json,confidence=excluded.confidence,source_type=excluded.source_type,updated_at=excluded.updated_at",params![id,category,serde_json::to_string(&stored_payload).unwrap_or("null".into()),merged_confidence,merged_source,merged_created,updated]).map_err(storage::db_error)?;
    Ok(())
}

fn persisted_payload(payload: &Value, stable: bool) -> Value {
    let mut output = serde_json::Map::new();
    for key in [
        "layer",
        "facet",
        "summary",
        "applies_when",
        "butler_should",
        "butler_should_not",
        "temporal_scope",
        "decay_policy",
        "contradiction_refs",
        "sensitivity",
        "evidence_refs",
        "evidence_observed_at",
        "evidence_count",
    ] {
        if let Some(value) = payload.get(key) {
            output.insert(key.into(), value.clone());
        }
    }
    if stable {
        output.insert(
            "sensitive_domain".into(),
            payload
                .get("sensitive_domain")
                .cloned()
                .unwrap_or(Value::Bool(false)),
        );
    }
    Value::Object(output)
}

fn merge_stable_payload(current: &mut Value, previous: &Value) {
    let Some(current) = current.as_object_mut() else {
        return;
    };
    for key in [
        "evidence_refs",
        "applies_when",
        "butler_should",
        "butler_should_not",
        "contradiction_refs",
    ] {
        let mut values = strings(previous, key);
        values.extend(
            current
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
        let limit = if key == "evidence_refs" { 24 } else { 6 };
        current.insert(
            key.into(),
            Value::Array(
                unique(values)
                    .into_iter()
                    .take(limit)
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    let mut observed = previous
        .get("evidence_observed_at")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(next) = current
        .get("evidence_observed_at")
        .and_then(Value::as_object)
    {
        for (key, value) in next {
            observed.insert(key.clone(), value.clone());
        }
    }
    current.insert("evidence_observed_at".into(), Value::Object(observed));
    let count = previous
        .get("evidence_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .max(
            current
                .get("evidence_count")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
    current.insert("evidence_count".into(), Value::from(count));
    let sensitivity = match (
        previous.get("sensitivity").and_then(Value::as_str),
        current.get("sensitivity").and_then(Value::as_str),
    ) {
        (Some("restricted"), _) | (_, Some("restricted")) => "restricted",
        (Some("sensitive"), _) | (_, Some("sensitive")) => "sensitive",
        _ => "normal",
    };
    current.insert("sensitivity".into(), Value::String(sensitivity.into()));
}
