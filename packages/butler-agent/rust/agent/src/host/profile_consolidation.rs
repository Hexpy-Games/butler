//! Source-order profile cycle adapter over one Profile owner and Cognition feedback reader.

use std::sync::Arc;

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{FeedbackBufferService, PhaseError},
    profile::{ProfileModelTranscriptCaptureOptions, ProfileService, ProfilingMode},
};

pub(super) struct ProfileConsolidation {
    pub(super) profile: Arc<ProfileService>,
    pub(super) feedback: Arc<FeedbackBufferService>,
}

impl ProfileConsolidation {
    pub(super) fn feedback_triage(&self) -> Result<Map<String, Value>, PhaseError> {
        let counts = self.feedback.counts(now_ms()).map_err(feedback_error)?;
        Ok(crate::json::json_object!({"active_feedback_count":counts.active_count}))
    }

    pub(super) async fn consolidate(
        &self,
        run_id: &str,
        cancellation: &CancellationToken,
    ) -> Result<Map<String, Value>, PhaseError> {
        // This route counts feedback for observability but currently captures candidates from transcripts only.
        let counts = self.feedback.counts(now_ms()).map_err(feedback_error)?;
        let feedback_count = counts.active_profile_candidate_count;
        let consent = self
            .profile
            .read_profiling_consent()
            .await
            .map_err(profile_error)?;
        if consent.mode == ProfilingMode::Off {
            return Ok(crate::json::json_object!({
                "profiling_enabled":false,
                "profile_feedback_count":feedback_count,
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
        let mut consolidated = serde_json::to_value(consolidated).map_err(|_| PhaseError {
            code: "consolidation_profile_metrics_failed",
            message: "consolidation_profile_metrics_failed".into(),
            metrics: Map::new(),
        })?;
        let mut metrics = std::mem::take(crate::json::object_mut(&mut consolidated));
        let more = crate::json::json_object!({
            "profile_feedback_count":feedback_count,
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
            return Err(PhaseError {
                code: "profile_consolidation_incomplete_coverage",
                message: "profile consolidation has unfinished source coverage".into(),
                metrics,
            });
        }
        Ok(metrics)
    }
}

fn now_ms() -> i64 {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).timestamp_millis()
}

fn profile_error(error: crate::profile::ProfileError) -> PhaseError {
    PhaseError {
        code: error.code,
        message: error.code.into(),
        metrics: Map::new(),
    }
}

fn feedback_error(error: crate::cognition::CognitionError) -> PhaseError {
    PhaseError {
        code: error.code,
        message: error.code.into(),
        metrics: Map::new(),
    }
}
