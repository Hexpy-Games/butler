//! Revising know-how entries from routed feedback.

use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::cognition::{CognitionResult, FeedbackTarget};
use butler_core::js_date;

use super::document::{KnowHowDocument, KnowHowStatus, RevisionKind};
use super::entries::EntryPath;

pub(super) struct Snapshot {
    pub entries: Vec<EntryPath>,
    pub quality_by_source: HashMap<String, f64>,
}

/// Active feedback aimed at this entry or at one of its preferred sources.
pub(super) fn targeted_feedback(
    entry: &KnowHowDocument,
    active_feedback: &[FeedbackTarget],
) -> CognitionResult<Vec<FeedbackTarget>> {
    let id = KnowHowDocument::required(&entry.knowhow_id)?;
    let targets = entry
        .preferred_sources()?
        .into_iter()
        .map(|source| format!("source:{source}"))
        .collect::<Vec<_>>();
    Ok(active_feedback
        .iter()
        .filter(|feedback| {
            feedback.target_ref == format!("knowhow:{id}")
                || targets.iter().any(|target| target == &feedback.target_ref)
        })
        .cloned()
        .collect())
}

/// The entry after `targeted` feedback: disabled for source-policy feedback,
/// else needing review; quality lowered, feedback referenced and recorded.
pub(super) fn revise_from_feedback(
    document: &KnowHowDocument,
    targeted: &[FeedbackTarget],
) -> CognitionResult<KnowHowDocument> {
    let mut next = document.clone();
    let previous_status = document.required_status()?.clone();
    let disable = targeted
        .iter()
        .any(|feedback| feedback.category == "source_policy");
    next.set_status(
        if disable {
            KnowHowStatus::Disabled
        } else {
            KnowHowStatus::NeedsReview
        },
        &now_iso(),
    );
    next.record_negative_feedback(targeted)?;
    next.push_history(
        RevisionKind::FeedbackRevision,
        Some(targeted),
        previous_status,
        now_iso(),
    )?;
    Ok(next)
}

/// Disables an entry with a preferred source scoring below 0.35, or sends
/// an active one to review below 0.55; returns whether it changed.
pub(super) fn demote_for_source_quality(
    document: &mut KnowHowDocument,
    quality_by_source: &HashMap<String, f64>,
) -> CognitionResult<bool> {
    let scores = document
        .preferred_sources()?
        .into_iter()
        .map(|source| quality_by_source.get(source).copied())
        .collect::<Vec<_>>();
    let current_status = document.required_status()?;
    let next_status = if scores.iter().flatten().any(|score| *score < 0.35) {
        Some(KnowHowStatus::Disabled)
    } else if scores.iter().flatten().any(|score| *score < 0.55)
        && *current_status == KnowHowStatus::Active
    {
        Some(KnowHowStatus::NeedsReview)
    } else {
        None
    };
    let Some(next_status) = next_status else {
        return Ok(false);
    };
    document.set_status(next_status, &now_iso());
    Ok(true)
}

fn now_iso() -> String {
    let millis = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(i64::MAX);
    js_date::format_iso_millis(millis).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}
