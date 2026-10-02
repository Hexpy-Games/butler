//! Consented feedback uses the existing candidate and stable-profile owner.
use super::{ProfileService, with_lease};
use crate::profile::ProfileFeedbackPromotion;
use crate::profile::contracts::ProfileCandidateInput;
use crate::profile::understanding::{CandidateDraft, CandidateStatus, Confidence, SourceType};
use crate::profile::{ProfileResult, candidates, storage};

impl ProfileService {
    /// Resolve only after the existing profile candidate owner accepts a stable entry.
    pub async fn promote_feedback(
        &self,
        feedback: ProfileFeedbackPromotion,
    ) -> ProfileResult<bool> {
        let root = self.data_root.clone();
        let coordinator = self.coordinator.clone();
        let lock = self.lock_path();
        let sources = self.canonical_sources.clone();
        let now = self.host.now_iso();
        let now_ms = self.host.now_epoch_millis();
        self.run(move || {
            with_lease(&coordinator, lock, "feedback_profile", || {
                (feedback.validate)()?;
                if feedback.text.chars().count() > 320 {
                    return Ok(false);
                }
                let input = ProfileCandidateInput {
                    category: feedback.category,
                    draft: CandidateDraft {
                        summary: feedback.text,
                        ..Default::default()
                    },
                    source_type: SourceType::Explicit,
                    confidence: Confidence::High,
                    sensitive_domain: false,
                    evidence_ref: Some(feedback.evidence_ref),
                    evidence_observed_at: Some(feedback.observed_at),
                    expires_or_decay: None,
                };
                let Some(candidate) = candidates::upsert(&root, &input, &now)? else {
                    return Ok(false);
                };
                let mode = storage::read_consent(&root).mode;
                candidates::consolidate(&root, sources.as_ref(), mode, &now, now_ms)?;
                let committed = candidates::upsert(&root, &input, &now)?
                    .is_some_and(|row| row.status == CandidateStatus::Promoted);
                if committed {
                    (feedback.committed)(&candidate.id)?;
                }
                Ok(committed)
            })
        })
        .await
    }
}
