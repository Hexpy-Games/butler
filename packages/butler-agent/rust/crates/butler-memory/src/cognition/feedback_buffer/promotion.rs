//! Persisted promotion authority, checked inside each destination's lease.
use super::{FeedbackEntry, FeedbackStatus, operator, store};
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A frozen feedback revision and reset generation, never a model-chosen destination.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeedbackPromotion {
    /// Stable feedback identity.
    pub feedback_id: String,
    /// Generation when classification started.
    pub generation: String,
    /// Revision when classification started.
    pub updated_at: String,
}

impl FeedbackPromotion {
    pub(super) fn of(entry: &FeedbackEntry, generation: String) -> Self {
        Self {
            feedback_id: entry.feedback_id.clone(),
            generation,
            updated_at: entry.updated_at.clone(),
        }
    }

    pub(crate) fn entry(&self, root: &Path) -> CognitionResult<FeedbackEntry> {
        if store::generation(root)? != self.generation {
            return Err(stale());
        }
        store::snapshot(root)?
            .into_iter()
            .find(|entry| {
                entry.feedback_id == self.feedback_id
                    && entry.updated_at == self.updated_at
                    && entry.is_active_at(chrono::Utc::now().timestamp_millis())
            })
            .ok_or_else(stale)
    }

    /// Called only after the destination is durably committed, under its lease.
    pub(crate) fn resolve(&self, root: &Path, destination: &str) -> CognitionResult<()> {
        if store::generation(root)? != self.generation {
            return Ok(());
        }
        let path = root.join("feedback.md");
        let mut entries = store::snapshot(root)?;
        if let Some(entry) = entries.iter_mut().find(|entry| {
            entry.feedback_id == self.feedback_id
                && entry.updated_at == self.updated_at
                && entry.status == FeedbackStatus::Active
        }) {
            entry.status = FeedbackStatus::Applied;
            entry.expires_at = None;
            entry.updated_at =
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            entry
                .extra_fields
                .insert("resolution_reason".into(), "promoted".into());
            entry
                .extra_fields
                .insert("destination_link".into(), destination.into());
            entry
                .extra_fields
                .insert("retention_class".into(), "audit".into());
            operator::write_entries(&path, &entries)?;
        }
        Ok(())
    }
}

fn stale() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemorySourceChanged,
        "Feedback revision changed",
    )
}

impl FeedbackPromotion {
    pub(super) fn profile_input(
        &self,
        root: std::path::PathBuf,
        entry: &FeedbackEntry,
        category: String,
    ) -> crate::profile::ProfileFeedbackPromotion {
        let validation = self.clone();
        let validate_root = root.clone();
        let committed = self.clone();
        crate::profile::ProfileFeedbackPromotion {
            text: entry.text.clone(),
            category,
            evidence_ref: format!("feedback:{}", self.feedback_id),
            observed_at: entry.created_at.clone(),
            validate: std::sync::Arc::new(move || {
                validation
                    .entry(&validate_root)
                    .map(|_| ())
                    .map_err(profile_error)
            }),
            committed: std::sync::Arc::new(move |destination| {
                committed.resolve(&root, destination).map_err(profile_error)
            }),
        }
    }
}
fn profile_error(error: CognitionError) -> crate::profile::ProfileError {
    crate::profile::ProfileError::new(
        crate::profile::ProfileCode::ProfileStoreUnavailable,
        "Feedback revision changed",
    )
    .with_source(error)
}

/// Blocking owner evidence read used by the host's profile source adapter.
pub fn feedback_evidence_is_current(
    root: &Path,
    reference: &str,
    destination: &str,
) -> CognitionResult<bool> {
    let Some(id) = reference.strip_prefix("feedback:") else {
        return Ok(false);
    };
    Ok(store::snapshot(root)?.iter().any(|entry| {
        entry.feedback_id == id
            && (entry.is_active_at(chrono::Utc::now().timestamp_millis())
                || entry
                    .extra_fields
                    .get("destination_link")
                    .is_some_and(|link| link == destination))
    }))
}
