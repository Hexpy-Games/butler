//! Profile candidates: merging extracted observations into stored
//! candidates, promoting ready candidates into the stable profile, and
//! expiring stale weak ones.

mod policy;
mod store;
use std::path::Path;

use super::contracts::{
    CanonicalProfileSourceFactory, ProfileCandidateInput, ProfileCandidateRecord,
    ProfileConsolidationResult, ProfileResult, ProfilingMode,
};
use super::understanding::{CandidateStatus, ObservedTimes, Sensitivity, Understanding};
use super::{projection, storage};
use crate::lenient::Arg;
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
    let db = storage::open(data_root, storage::Access::Write)?;
    upsert_in_db(&db, input, now)
}

/// Merges `input` into its stored candidate (keyed by category, facet and
/// summary); a candidate that is already promoted also refreshes its stable
/// entry.
pub(super) fn upsert_in_db(
    db: &rusqlite::Connection,
    input: &ProfileCandidateInput,
    now: &str,
) -> ProfileResult<Option<ProfileCandidateRecord>> {
    let summary = normalize_text(&input.draft.summary, 320);
    if summary.is_empty() {
        return Ok(None);
    }
    let id = identifier(
        "pc_",
        &input.category,
        input.draft.facet.as_deref(),
        &summary,
    );
    let previous = read_candidate(db, &id)?;
    let candidate = merged(input, previous.as_ref(), id, summary, now);
    write_candidate(db, &candidate)?;
    if candidate.status == CandidateStatus::Promoted {
        write_stable(db, &StableWrite::of(&candidate, now))?;
    }
    Ok(Some(candidate))
}

/// The evidence of a candidate after one more observation.
struct Evidence {
    refs: Vec<String>,
    count: u64,
    observed: ObservedTimes,
    /// The observation was already recorded.
    duplicate: bool,
    /// When the new observation was made, when known.
    observed_at: Option<String>,
}

fn evidence(input: &ProfileCandidateInput, previous: Option<&Understanding>) -> Evidence {
    let reference = input
        .evidence_ref
        .as_deref()
        .map(|value| normalize_text(value, 160))
        .filter(|value| !value.is_empty());
    let mut refs = previous
        .map(|value| value.evidence_refs.clone())
        .unwrap_or_default();
    let duplicate = reference
        .as_ref()
        .is_some_and(|reference| refs.contains(reference));
    if let Some(reference) = &reference {
        refs.push(reference.clone());
    }
    let refs = unique(refs);
    let count = (refs.len() as u64).max(
        previous
            .and_then(|value| value.evidence_count.as_u64())
            .unwrap_or(0),
    );
    let mut observed = previous
        .map(|value| value.evidence_observed_at.clone())
        .unwrap_or_default();
    let observed_at = input
        .evidence_observed_at
        .as_deref()
        .and_then(normalize_observed_at);
    if let Some(reference) = reference {
        observed
            .entry(reference)
            .or_insert_with(|| observed_at.clone().map_or(Arg::Null, Arg::Valid));
    }
    Evidence {
        refs,
        count,
        observed,
        duplicate,
        observed_at,
    }
}

/// The stored candidate after merging `input` into `previous`: evidence
/// accumulates, source and confidence only grow, and a duplicate
/// observation keeps the stored times.
fn merged(
    input: &ProfileCandidateInput,
    previous: Option<&ProfileCandidateRecord>,
    id: String,
    summary: String,
    now: &str,
) -> ProfileCandidateRecord {
    let evidence = evidence(input, previous.map(|value| &value.understanding));
    let facet = input.draft.facet.as_deref();
    let declared_sensitive =
        input.sensitive_domain || previous.is_some_and(|value| value.sensitive_domain);
    let sensitive = normalize_sensitive(&input.category, facet, declared_sensitive);
    let shape = merge_understanding(&input.draft, previous, &input.category, &summary, sensitive);
    let stored = |field: fn(&ProfileCandidateRecord) -> &String| {
        previous
            .map_or(now, |value| field(value).as_str())
            .to_owned()
    };
    let (updated_at, last_seen_at) = if evidence.duplicate {
        (
            stored(|value| &value.updated_at),
            stored(|value| &value.last_seen_at),
        )
    } else {
        (
            now.to_owned(),
            later_observed(
                previous.map(|value| value.last_seen_at.as_str()),
                evidence.observed_at.as_deref().unwrap_or(now),
            ),
        )
    };
    ProfileCandidateRecord {
        layer: shape.layer,
        category: input.category.clone(),
        understanding: Understanding {
            facet: input.draft.facet.clone(),
            summary,
            applies_when: shape.applies_when,
            butler_should: shape.butler_should,
            butler_should_not: shape.butler_should_not,
            temporal_scope: shape.temporal_scope,
            decay_policy: shape.decay_policy,
            contradiction_refs: shape.contradiction_refs,
            sensitivity: shape.sensitivity,
            evidence_refs: evidence.refs,
            evidence_observed_at: evidence.observed,
            evidence_count: evidence.count.into(),
        },
        source_type: previous.map_or(input.source_type, |value| {
            value.source_type.max(input.source_type)
        }),
        confidence: previous.map_or(input.confidence, |value| {
            value.confidence.max(input.confidence)
        }),
        sensitive_domain: sensitive,
        status: if previous.is_some_and(|value| value.status == CandidateStatus::Promoted) {
            CandidateStatus::Promoted
        } else {
            CandidateStatus::Candidate
        },
        created_at: stored(|value| &value.created_at),
        updated_at,
        last_seen_at,
        expires_or_decay: input
            .expires_or_decay
            .or(previous.and_then(|value| value.expires_or_decay)),
        promoted_at: None,
        id,
    }
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
    let db = storage::open(data_root, storage::Access::Write)?;
    let candidates = pending_rows(&db)?
        .into_iter()
        .filter_map(hydrate)
        .collect::<Vec<_>>();
    let candidate_count = candidates.len();
    let promotion = promote_ready(&db, sources, candidates, mode, now)?;
    let rejected = expire_old_candidates(&db, now, now_ms)?;
    drop(db);
    let stable_count = storage::stable_entries(data_root)?.len();
    let projection_written = refresh_projection(data_root, sources, mode, now, now_ms)?;
    Ok(ProfileConsolidationResult {
        profiling_enabled: true,
        mode,
        candidate_count,
        promoted_count: promotion.promoted,
        skipped_count: promotion.skipped,
        rejected_count: rejected,
        stable_entry_count: stable_count,
        projection_written,
        raw_text_included: false,
    })
}

struct Promotion {
    promoted: usize,
    skipped: usize,
}

/// Re-checks each pending candidate's sensitivity and promotes the ones
/// that are allowed in `mode` and have enough evidence.
fn promote_ready(
    db: &rusqlite::Connection,
    sources: &dyn CanonicalProfileSourceFactory,
    candidates: Vec<ProfileCandidateRecord>,
    mode: ProfilingMode,
    now: &str,
) -> ProfileResult<Promotion> {
    let mut promotion = Promotion {
        promoted: 0,
        skipped: 0,
    };
    for mut candidate in candidates {
        if candidate
            .understanding
            .evidence_refs
            .iter()
            .any(|reference| {
                reference.starts_with("feedback:")
                    && !sources
                        .verified_feedback(reference, &candidate.id)
                        .unwrap_or(false)
            })
        {
            promotion.skipped += 1;
            continue;
        }
        let declared_sensitive = candidate.sensitive_domain;
        let sensitive = normalize_sensitive(
            &candidate.category,
            candidate.understanding.facet.as_deref(),
            declared_sensitive,
        );
        if sensitive != declared_sensitive {
            candidate.sensitive_domain = sensitive;
            if !sensitive {
                candidate.understanding.sensitivity = Sensitivity::Normal;
            }
            write_candidate(db, &candidate)?;
        }
        if !category_allowed(&candidate.category, mode)
            || (mode == ProfilingMode::Basic && sensitive)
            || !ready(&candidate)
        {
            promotion.skipped += 1;
            continue;
        }
        write_stable(db, &StableWrite::of(&candidate, now))?;
        candidate.status = CandidateStatus::Promoted;
        candidate.promoted_at = Some(now.into());
        candidate.updated_at = now.into();
        write_candidate(db, &candidate)?;
        promotion.promoted += 1;
    }
    Ok(promotion)
}

/// Rebuilds the runtime projection from the eligible stable entries, or
/// removes it when nothing would be projected; `true` when one was written.
fn refresh_projection(
    data_root: &Path,
    sources: &dyn CanonicalProfileSourceFactory,
    mode: ProfilingMode,
    now: &str,
    now_ms: i64,
) -> ProfileResult<bool> {
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
    Ok(written.is_some())
}

fn expire_old_candidates(
    db: &rusqlite::Connection,
    now: &str,
    now_ms: i64,
) -> ProfileResult<usize> {
    let cutoff = now_ms - 90 * 86_400_000;
    let mut expired = 0;
    for mut candidate in decay_rows(db)?.into_iter().filter_map(hydrate) {
        if parse_time(&candidate.updated_at).is_some_and(|value| value >= cutoff) {
            continue;
        }
        candidate.status = CandidateStatus::Expired;
        candidate.updated_at = now.into();
        write_candidate(db, &candidate)?;
        expired += 1;
    }
    Ok(expired)
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
