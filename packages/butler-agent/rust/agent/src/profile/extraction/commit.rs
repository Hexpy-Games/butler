use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::super::contracts::{
    CanonicalProfileSourceFactory, ProfileCandidateInput, ProfileError, ProfileHostFacts,
    ProfileResult, ProfilingConsentSnapshot, ProfilingMode,
};
use super::super::{candidates, projection, storage};
use super::discovery;
use super::targets::{normalized_conditions, revision};
use super::types::{CorrectionTarget, ExtractedCandidate, SourceWindow};
use crate::models::PromptUsageReport;

pub(super) struct CommitInput<'a> {
    pub(super) root: &'a Path,
    pub(super) sources: &'a dyn CanonicalProfileSourceFactory,
    pub(super) host: &'a dyn ProfileHostFacts,
    pub(super) expected_consent: &'a ProfilingConsentSnapshot,
    pub(super) windows: &'a [SourceWindow],
    pub(super) extracted: Vec<ExtractedCandidate>,
    pub(super) usage: Option<&'a PromptUsageReport>,
    pub(super) offered_corrections: &'a HashMap<String, CorrectionTarget>,
    pub(super) nonce: &'a str,
}

pub(super) fn commit(input: CommitInput<'_>) -> ProfileResult<HashSet<String>> {
    let CommitInput {
        root,
        sources,
        host,
        expected_consent: expected,
        windows,
        extracted,
        usage,
        offered_corrections: offered,
        nonce,
    } = input;
    let mut db = storage::open(root, true)?;
    let tx = db.transaction().map_err(storage::db_error)?;
    let consent = consent_from_db(&tx)?;
    if consent.mode == ProfilingMode::Off
        || consent.mode != expected.mode
        || consent.consent_version != expected.consent_version
    {
        return Err(interruption("profiling consent changed"));
    }
    for window in windows {
        let owner = tx
            .query_row(
                "SELECT owner_pid,owner_nonce FROM profile_source_coverage WHERE coverage_key=?1",
                [&window.coverage_key],
                |row| {
                    Ok((
                        row.get::<_, Option<f64>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(storage::db_error)?;
        if !owner.is_some_and(|(pid, value)| {
            pid == Some(f64::from(host.process_id())) && value.as_deref() == Some(nonce)
        }) {
            return Err(interruption("memory_write_busy"));
        }
        let mut reader = sources.open()?;
        let current = discovery::current_text(reader.as_mut(), window);
        let close = reader.close();
        close?;
        let current = current?;
        if current.as_deref() != Some(window.text.as_ref()) {
            return Err(interruption("profile source changed"));
        }
    }
    validate_targets(
        root,
        sources,
        &tx,
        expected.mode,
        host.now_epoch_millis(),
        &extracted,
        offered,
    )?;
    let observed = windows
        .iter()
        .map(|value| (value.evidence_ref.as_str(), value.timestamp.as_str()))
        .collect::<HashMap<_, _>>();
    let mut ids = HashSet::new();
    for candidate in extracted {
        for evidence in &candidate.evidence_refs {
            let input = ProfileCandidateInput {
                category: candidate.category.clone(),
                payload: candidate.payload.clone(),
                source_type: candidate.source_type.clone(),
                confidence: candidate.confidence.clone(),
                sensitive_domain: candidate.sensitive_domain,
                evidence_ref: Some(evidence.clone()),
                evidence_observed_at: observed
                    .get(evidence.as_str())
                    .map(|value| (*value).to_owned()),
                expires_or_decay: candidate.expires_or_decay.clone(),
            };
            if let Some(record) = candidates::upsert_in_db(&tx, &input, &host.now_iso())? {
                ids.insert(record.id);
            }
        }
    }
    let usage_json = usage_value(usage).to_string();
    let now = host.now_iso();
    let mut complete=tx.prepare("UPDATE profile_source_coverage SET disposition='complete',failure_code=NULL,usage_json=?1,owner_pid=NULL,owner_nonce=NULL,claimed_at=NULL,updated_at=?2 WHERE coverage_key=?3 AND owner_pid=?4 AND owner_nonce=?5").map_err(storage::db_error)?;
    for window in windows {
        complete
            .execute(params![
                usage_json,
                now,
                window.coverage_key,
                f64::from(host.process_id()),
                nonce
            ])
            .map_err(storage::db_error)?;
    }
    drop(complete);
    tx.commit().map_err(storage::db_error)?;
    Ok(ids)
}

fn validate_targets(
    root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    db: &rusqlite::Transaction<'_>,
    mode: ProfilingMode,
    now_ms: i64,
    candidates: &[ExtractedCandidate],
    offered: &HashMap<String, CorrectionTarget>,
) -> ProfileResult<()> {
    let eligible = projection::correction_entries_in_db(root, sources, db, mode, now_ms)?;
    let eligible = eligible
        .into_iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect::<HashMap<_, _>>();
    for candidate in candidates {
        let target_ids = candidate
            .payload
            .get("contradiction_refs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str);
        for id in target_ids {
            let Some(target) = offered.values().find(|value| value.stable_id == id) else {
                return Err(interruption("profile correction target changed"));
            };
            let current = eligible.get(id);
            let facet = candidate.payload.get("facet").and_then(Value::as_str);
            let conditions = normalized_conditions(
                candidate
                    .payload
                    .get("applies_when")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
            );
            if current
                .as_ref()
                .is_none_or(|value| revision(value) != target.revision)
                || candidate.source_type != "explicit"
                || candidate.category != target.category
                || facet != target.facet.as_deref()
                || conditions != target.applies_when
            {
                return Err(interruption("profile correction target changed"));
            }
        }
    }
    Ok(())
}

fn consent_from_db(db: &rusqlite::Connection) -> ProfileResult<ProfilingConsentSnapshot> {
    let mut values = Map::new();
    let mut statement=db.prepare("SELECT key,value_json FROM profile_meta WHERE key IN ('mode','consent_version','consented_at')").map_err(storage::db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage::db_error)?;
    for row in rows {
        let (key, raw) = row.map_err(storage::db_error)?;
        values.insert(key, serde_json::from_str(&raw).unwrap_or(Value::Null));
    }
    let mode = values
        .get("mode")
        .and_then(Value::as_str)
        .map(ProfilingMode::parse)
        .unwrap_or(ProfilingMode::Off);
    Ok(ProfilingConsentSnapshot {
        mode,
        consent_version: values
            .get("consent_version")
            .and_then(Value::as_str)
            .unwrap_or(storage::CONSENT_VERSION)
            .into(),
        consented_at: (mode != ProfilingMode::Off)
            .then(|| {
                values
                    .get("consented_at")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten(),
        raw_profile_browser_visible: false,
    })
}

pub(super) fn usage_value(usage: Option<&PromptUsageReport>) -> Value {
    usage.map(|value|json!({"model":value.model,"promptTokens":value.prompt_tokens,"cachedTokens":value.cached_tokens,"totalTokens":value.total_tokens})).unwrap_or(Value::Null)
}
fn interruption(message: &str) -> ProfileError {
    ProfileError::new("profile_commit_interrupted", message)
}
