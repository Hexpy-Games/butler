mod policy;
mod store;
use std::path::Path;

use serde_json::Value;

use super::contracts::{
    CanonicalProfileSourceFactory, ProfileCandidateInput, ProfileCandidateRecord,
    ProfileConsolidationResult, ProfileResult, ProfilingMode,
};
use super::{projection, storage};
use policy::*;
use store::*;

pub(super) fn upsert(
    data_root: &Path,
    input: &ProfileCandidateInput,
    now: &str,
) -> ProfileResult<Option<ProfileCandidateRecord>> {
    let consent = storage::read_consent(data_root);
    if !category_allowed(&input.category, consent.mode) {
        return Ok(None);
    }
    let db = storage::open(data_root, true)?;
    upsert_in_db(&db, input, now)
}

pub(super) fn upsert_in_db(
    db: &rusqlite::Connection,
    input: &ProfileCandidateInput,
    now: &str,
) -> ProfileResult<Option<ProfileCandidateRecord>> {
    let summary = normalize_text(
        input
            .payload
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or(""),
        320,
    );
    if summary.is_empty() {
        return Ok(None);
    }
    let facet = input.payload.get("facet").and_then(Value::as_str);
    let id = identifier("pc_", &input.category, facet, &summary);
    let existing = read_candidate(db, &id)?;
    let mut payload = input.payload.as_object().cloned().unwrap_or_default();
    let previous = existing
        .as_ref()
        .and_then(|record| record.payload.as_object());
    payload.insert("id".into(), Value::String(id.clone()));
    payload.insert("category".into(), Value::String(input.category.clone()));
    payload.insert("summary".into(), Value::String(summary));
    let evidence = input
        .evidence_ref
        .as_deref()
        .map(|value| normalize_text(value, 160))
        .filter(|value| !value.is_empty());
    let mut refs = previous
        .and_then(|value| value.get("evidence_refs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let duplicate_evidence = evidence
        .as_ref()
        .is_some_and(|reference| refs.contains(reference));
    if let Some(reference) = &evidence {
        refs.push(reference.clone());
    }
    refs = unique(refs);
    payload.insert(
        "evidence_refs".into(),
        Value::Array(refs.iter().cloned().map(Value::String).collect()),
    );
    let evidence_count = (refs.len() as u64).max(
        previous
            .and_then(|value| value.get("evidence_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    );
    payload.insert("evidence_count".into(), Value::from(evidence_count));
    let mut observed = previous
        .and_then(|value| value.get("evidence_observed_at"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let observed_at = input
        .evidence_observed_at
        .as_deref()
        .and_then(normalize_observed_at);
    if let Some(reference) = evidence {
        observed.entry(reference).or_insert_with(|| {
            observed_at
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null)
        });
    }
    payload.insert("evidence_observed_at".into(), Value::Object(observed));
    let source_type = stronger(
        previous
            .and_then(|value| value.get("source_type"))
            .and_then(Value::as_str),
        &input.source_type,
        &[
            "inference",
            "repeated_observation",
            "explicit",
            "user_confirmed",
        ],
    );
    let confidence = stronger(
        previous
            .and_then(|value| value.get("confidence"))
            .and_then(Value::as_str),
        &input.confidence,
        &["low", "medium", "high"],
    );
    let created = previous
        .and_then(|value| value.get("created_at"))
        .and_then(Value::as_str)
        .unwrap_or(now);
    let status = previous
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .filter(|value| *value == "promoted")
        .unwrap_or("candidate");
    let expires = input
        .expires_or_decay
        .as_deref()
        .filter(|value| matches!(*value, "expires" | "decay"))
        .or_else(|| {
            previous
                .and_then(|value| value.get("expires_or_decay"))
                .and_then(Value::as_str)
        });
    let declared_sensitive = input.sensitive_domain
        || previous
            .and_then(|value| value.get("sensitive_domain"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let sensitive = normalize_sensitive(&input.category, facet, declared_sensitive);
    merge_understanding(&mut payload, previous, &input.category, sensitive);
    let updated = if duplicate_evidence {
        previous
            .and_then(|value| value.get("updated_at"))
            .and_then(Value::as_str)
            .unwrap_or(now)
    } else {
        now
    };
    let last_seen = if duplicate_evidence {
        previous
            .and_then(|value| value.get("last_seen_at"))
            .and_then(Value::as_str)
            .unwrap_or(now)
            .to_owned()
    } else {
        later_observed(
            previous
                .and_then(|value| value.get("last_seen_at"))
                .and_then(Value::as_str),
            observed_at.as_deref().unwrap_or(now),
        )
    };
    for (key, value) in [
        ("source_type", source_type),
        ("confidence", confidence),
        ("status", status),
        ("created_at", created),
        ("updated_at", updated),
        ("last_seen_at", last_seen.as_str()),
    ] {
        payload.insert(key.into(), Value::String(value.into()));
    }
    payload.insert("sensitive_domain".into(), Value::Bool(sensitive));
    payload.insert(
        "expires_or_decay".into(),
        expires
            .map(|value| Value::String(value.to_owned()))
            .unwrap_or(Value::Null),
    );
    payload.entry("promoted_at").or_insert(Value::Null);
    write_candidate(
        db,
        &id,
        &input.category,
        source_type,
        confidence,
        sensitive,
        created,
        updated,
        &last_seen,
        expires,
        status,
        &Value::Object(payload.clone()),
    )?;
    if status == "promoted" {
        let stable_id = identifier(
            "sp_",
            &input.category,
            facet,
            payload.get("summary").and_then(Value::as_str).unwrap_or(""),
        );
        let mut stable = Value::Object(payload.clone());
        if let Some(object) = stable.as_object_mut() {
            object.insert("id".into(), Value::String(stable_id.clone()));
            for key in ["status", "promoted_at", "last_seen_at", "expires_or_decay"] {
                object.shift_remove(key);
            }
        }
        write_stable(
            db,
            &stable_id,
            &input.category,
            confidence,
            source_type,
            now,
            now,
            &stable,
        )?;
    }
    Ok(Some(ProfileCandidateRecord {
        id,
        payload: Value::Object(payload),
    }))
}

pub(super) fn consolidate(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    mode: ProfilingMode,
    now: &str,
    now_ms: i64,
) -> ProfileResult<ProfileConsolidationResult> {
    if mode == ProfilingMode::Off {
        storage::delete_projection(data_root)?;
        return Ok(ProfileConsolidationResult {
            profiling_enabled: false,
            mode,
            candidate_count: 0,
            promoted_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            stable_entry_count: 0,
            projection_written: false,
            raw_text_included: false,
        });
    }
    let db = storage::open(data_root, true)?;
    let candidates = pending_rows(&db)?
        .into_iter()
        .filter_map(hydrate)
        .collect::<Vec<_>>();
    let candidate_count = candidates.len();
    let mut promoted = 0;
    let mut skipped = 0;
    for mut candidate in candidates {
        let category = text(&candidate.payload, "category")
            .unwrap_or("")
            .to_owned();
        let facet = text(&candidate.payload, "facet");
        let declared_sensitive = candidate
            .payload
            .get("sensitive_domain")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let sensitive = normalize_sensitive(&category, facet, declared_sensitive);
        if sensitive != declared_sensitive {
            if let Some(payload) = candidate.payload.as_object_mut() {
                payload.insert("sensitive_domain".into(), Value::Bool(sensitive));
                if !sensitive {
                    payload.insert("sensitivity".into(), Value::String("normal".into()));
                }
            }
            write_record(&db, &candidate)?;
        }
        if !category_allowed(&category, mode) || (mode == ProfilingMode::Basic && sensitive) {
            skipped += 1;
            continue;
        }
        let source = text(&candidate.payload, "source_type").unwrap_or("");
        let confidence = text(&candidate.payload, "confidence").unwrap_or("");
        if ready(&candidate.payload, &category, source, confidence) {
            let stable_id = identifier(
                "sp_",
                &category,
                text(&candidate.payload, "facet"),
                text(&candidate.payload, "summary").unwrap_or(""),
            );
            let mut stable = candidate.payload.clone();
            if let Some(object) = stable.as_object_mut() {
                object.insert("id".into(), Value::String(stable_id.clone()));
                for key in ["status", "promoted_at", "last_seen_at", "expires_or_decay"] {
                    object.shift_remove(key);
                }
            }
            write_stable(
                &db, &stable_id, &category, confidence, source, now, now, &stable,
            )?;
            if let Some(value) = candidate.payload.as_object_mut() {
                value.insert("status".into(), Value::String("promoted".into()));
                value.insert("promoted_at".into(), Value::String(now.into()));
                value.insert("updated_at".into(), Value::String(now.into()));
            }
            write_record(&db, &candidate)?;
            promoted += 1;
        } else {
            skipped += 1;
        }
    }
    let rejected = expire_old_candidates(&db, now, now_ms)?;
    drop(db);
    let stable = storage::stable_entries(data_root)?;
    let stable_count = stable.len();
    let generated =
        projection::build_current(data_root, sources, mode, now_ms, now_ms as f64, now.into())?;
    let written = generated.as_ref().filter(|value| {
        !value.response_hints.is_empty()
            || !value.current_attention.is_empty()
            || !value.caution_hints.is_empty()
    });
    if let Some(generated) = written {
        storage::write_projection(data_root, generated)?;
    } else {
        storage::delete_projection(data_root)?;
    }
    Ok(ProfileConsolidationResult {
        profiling_enabled: true,
        mode,
        candidate_count,
        promoted_count: promoted,
        skipped_count: skipped,
        rejected_count: rejected,
        stable_entry_count: stable_count,
        projection_written: written.is_some(),
        raw_text_included: false,
    })
}

fn expire_old_candidates(
    db: &rusqlite::Connection,
    now: &str,
    now_ms: i64,
) -> ProfileResult<usize> {
    let cutoff = now_ms - 90 * 86_400_000;
    let mut expired = 0;
    for mut candidate in decay_rows(db)?.into_iter().filter_map(hydrate) {
        let updated = text(&candidate.payload, "updated_at").unwrap_or("");
        if parse_time(updated).is_some_and(|value| value >= cutoff) {
            continue;
        }
        if let Some(payload) = candidate.payload.as_object_mut() {
            payload.insert("status".into(), Value::String("expired".into()));
            payload.insert("updated_at".into(), Value::String(now.into()));
        }
        write_record(db, &candidate)?;
        expired += 1;
    }
    Ok(expired)
}

fn write_record(
    db: &rusqlite::Connection,
    candidate: &ProfileCandidateRecord,
) -> ProfileResult<()> {
    let payload = &candidate.payload;
    write_candidate(
        db,
        &candidate.id,
        text(payload, "category").unwrap_or(""),
        text(payload, "source_type").unwrap_or("inference"),
        text(payload, "confidence").unwrap_or("low"),
        payload
            .get("sensitive_domain")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        text(payload, "created_at").unwrap_or(""),
        text(payload, "updated_at").unwrap_or(""),
        text(payload, "last_seen_at").unwrap_or(""),
        text(payload, "expires_or_decay"),
        text(payload, "status").unwrap_or("candidate"),
        &payload.clone(),
    )
}

fn later_observed(left: Option<&str>, right: &str) -> String {
    match (left.and_then(parse_time), parse_time(right)) {
        (Some(left_ms), Some(right_ms)) if left_ms > right_ms => left.unwrap_or(right).to_owned(),
        _ => right.to_owned(),
    }
}

fn normalize_observed_at(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| {
            value
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
}
