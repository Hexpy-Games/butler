//! Profile consolidation and instruction expiry over their respective owners.

use std::sync::Arc;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use butler_memory::cognition::PhaseError;
use butler_memory::profile::{ProfileModelTranscriptCaptureOptions, ProfileService, ProfilingMode};

pub(in crate::host) struct ProfileConsolidation {
    pub(in crate::host) rules: butler_memory::cognition::RememberedRuleOwner,
    pub(in crate::host) profile: Arc<ProfileService>,
}

impl ProfileConsolidation {
    pub(in crate::host) async fn feedback_triage(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Map<String, Value>, PhaseError> {
        let count = self
            .rules
            .expire(cancellation.clone())
            .await
            .map_err(feedback_error)?;
        Ok(butler_core::json::json_object!({"expired_instructions": count}))
    }

    pub(in crate::host) async fn consolidate(
        &self,
        run_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Map<String, Value>, PhaseError> {
        let consent = self
            .profile
            .read_profiling_consent()
            .await
            .map_err(profile_error)?;
        if consent.mode == ProfilingMode::Off {
            return Ok(butler_core::json::json_object!({
                "profiling_enabled":false,
                "profile_feedback_count":0,
                "captured_candidate_count":0,
                "applied_feedback_count":0,
                "raw_text_included":false,
            }));
        }
        let capture = self
            .profile
            .capture_profile_candidates_from_transcripts_with_model(
                ProfileModelTranscriptCaptureOptions {
                    cache_scope: Some(format!(
                        "cognition:{run_id}:profile_consolidation:profile-extractor"
                    )),
                    cancellation: cancellation.clone(),
                    ..ProfileModelTranscriptCaptureOptions::default()
                },
            )
            .await
            .map_err(profile_error)?;

        let consolidated = self
            .profile
            .consolidate_profile_candidates()
            .await
            .map_err(profile_error)?;
        let mut consolidated = profile_metrics(consolidated)?;
        let mut metrics = std::mem::take(butler_core::json::object_mut(&mut consolidated));
        let more = butler_core::json::json_object!({
            "profile_feedback_count":0,
            "transcript_since":Value::Null,
            "semantic_scanned_session_count":capture.semantic_scanned_session_count,
            "semantic_scanned_message_count":capture.semantic_scanned_message_count,
            "semantic_captured_candidate_count":capture.captured_candidate_count,
            "audit_transcript_scanned_file_count":capture.audit_transcript_scanned_file_count,
            "audit_transcript_scanned_event_count":capture.audit_transcript_scanned_event_count,
            "transcript_scanned_file_count":capture.audit_transcript_scanned_file_count,
            "transcript_scanned_event_count":capture.audit_transcript_scanned_event_count,
            "transcript_captured_candidate_count":capture.captured_candidate_count,
            "transcript_extractor_model":capture.extractor_model.effective_model,
            "transcript_extractor_uses_butler_model":capture.extractor_model.uses_butler_model,
            "transcript_extractor_model_called":capture.model_called,
            "transcript_extractor_fallback_used":capture.fallback_used,
            "transcript_extractor_error":capture.model_error.as_ref().map(|_| "profile extractor model failed"),
            "coverage_pending_count":capture.coverage_pending_count.unwrap_or(0),
            "coverage_failed_count":capture.coverage_failed_count.unwrap_or(0),
            "coverage_complete_count":capture.coverage_complete_count.unwrap_or(0),
            "coverage_discovery_incomplete_count":capture.coverage_discovery_incomplete_count.unwrap_or(0),
            "model_usage":capture.model_usage,
            "captured_candidate_count":0,
            "applied_feedback_count":0,
            "raw_text_included":false,
        });
        metrics.extend(more);
        if capture.model_error.is_some() {
            return Err(PhaseError::new(
                "profile_consolidation_incomplete_coverage",
                "profile consolidation has unfinished source coverage",
            )
            .with_metrics(metrics));
        }
        Ok(metrics)
    }
}

fn profile_error(error: butler_memory::profile::ProfileError) -> PhaseError {
    PhaseError::new(error.code(), error.code()).with_source(error)
}

fn feedback_error(error: butler_memory::cognition::CognitionError) -> PhaseError {
    PhaseError::new(error.code(), error.code()).with_source(error)
}

fn profile_metrics(value: impl serde::Serialize) -> Result<Value, PhaseError> {
    serde_json::to_value(value).map_err(|source| {
        PhaseError::new(
            "consolidation_profile_metrics_failed",
            "consolidation_profile_metrics_failed",
        )
        .with_source(source)
    })
}
