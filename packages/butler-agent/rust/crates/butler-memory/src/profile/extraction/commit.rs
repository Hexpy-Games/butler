//! Committing an extracted batch: re-validating what the batch was built
//! from, storing its candidates, and completing its coverage.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value};

use super::super::contracts::{
    CanonicalProfileSourceFactory, ProfileCandidateInput, ProfileError, ProfileHostFacts,
    ProfileResult, ProfilingConsentSnapshot, ProfilingMode,
};
use super::super::{candidates, projection, storage};
use super::discovery;
use super::targets::{normalized_conditions, revision};
use super::types::{CorrectionTarget, ExtractedCandidate, SourceWindow};
use crate::profile::ProfileCode;
use crate::profile::understanding::SourceType;
use butler_models::models::PromptUsageReport;

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

/// Commits one extracted batch in a single transaction: the consent, the
/// batch's coverage claim, its source text and every correction target must
/// be unchanged, then the candidates are stored and the coverage completed.
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
    let mut db = storage::open(root, storage::Access::Write)?;
    let tx = db.transaction().map_err(storage::db_error)?;
    let consent = consent_from_db(&tx)?;
    if consent.mode == ProfilingMode::Off
        || consent.mode != expected.mode
        || consent.consent_version != expected.consent_version
    {
        return Err(interruption("profiling consent changed"));
    }
    for window in windows {
        verify_claim(&tx, sources, host, window, nonce)?;
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
    let ids = store_candidates(&tx, host, windows, extracted)?;
    complete_coverage(&tx, host, windows, usage, nonce)?;
    tx.commit().map_err(storage::db_error)?;
    Ok(ids)
}

/// The window must still be claimed by this batch and read the same text.
fn verify_claim(
    tx: &rusqlite::Transaction<'_>,
    sources: &dyn CanonicalProfileSourceFactory,
    host: &dyn ProfileHostFacts,
    window: &SourceWindow,
    nonce: &str,
) -> ProfileResult<()> {
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
    Ok(())
}

/// Merges each candidate once per evidence ref, observed when its window
/// was written; the ids of the stored candidates.
fn store_candidates(
    tx: &rusqlite::Transaction<'_>,
    host: &dyn ProfileHostFacts,
    windows: &[SourceWindow],
    extracted: Vec<ExtractedCandidate>,
) -> ProfileResult<HashSet<String>> {
    let observed = windows
        .iter()
        .map(|value| (value.evidence_ref.as_str(), value.timestamp.as_str()))
        .collect::<HashMap<_, _>>();
    let mut ids = HashSet::new();
    for candidate in extracted {
        for evidence in &candidate.evidence_refs {
            let input = ProfileCandidateInput {
                category: candidate.category.clone(),
                draft: candidate.draft.clone(),
                source_type: candidate.source_type,
                confidence: candidate.confidence,
                sensitive_domain: candidate.sensitive_domain,
                evidence_ref: Some(evidence.clone()),
                evidence_observed_at: observed
                    .get(evidence.as_str())
                    .map(|value| (*value).to_owned()),
                expires_or_decay: candidate.expires_or_decay,
            };
            if let Some(record) = candidates::upsert_in_db(tx, &input, &host.now_iso())? {
                ids.insert(record.id);
            }
        }
    }
    Ok(ids)
}

/// Marks the batch's claimed coverage complete with the provider usage.
fn complete_coverage(
    tx: &rusqlite::Transaction<'_>,
    host: &dyn ProfileHostFacts,
    windows: &[SourceWindow],
    usage: Option<&PromptUsageReport>,
    nonce: &str,
) -> ProfileResult<()> {
    let usage_json = usage_json(usage)?;
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
    Ok(())
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
        for id in &candidate.draft.contradiction_refs {
            let Some(target) = offered.values().find(|value| value.stable_id == *id) else {
                return Err(interruption("profile correction target changed"));
            };
            let current_revision = eligible.get(id).map(revision).transpose()?;
            let conditions = normalized_conditions(candidate.draft.applies_when.clone());
            if current_revision.is_none_or(|value| value != target.revision)
                || candidate.source_type != SourceType::Explicit
                || candidate.category != target.category
                || candidate.draft.facet != target.facet
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

/// The provider usage stored with completed coverage rows (`usage_json`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredUsage<'a> {
    model: &'a str,
    prompt_tokens: Option<f64>,
    cached_tokens: f64,
    total_tokens: Option<f64>,
}

pub(super) fn usage_json(usage: Option<&PromptUsageReport>) -> ProfileResult<String> {
    let usage = usage.map(|value| StoredUsage {
        model: &value.model,
        prompt_tokens: value.prompt_tokens,
        cached_tokens: value.cached_tokens,
        total_tokens: value.total_tokens,
    });
    serde_json::to_string(&usage).map_err(storage::json_error)
}
fn interruption(message: &str) -> ProfileError {
    ProfileError::new(ProfileCode::ProfileCommitInterrupted, message)
}
