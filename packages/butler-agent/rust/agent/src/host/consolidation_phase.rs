//! Required Host phase port: implemented effects or typed unavailable errors.

use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        BoxStoreService, CycleEventSink, FeedbackBufferService, KnowHowService,
        LegacyMetadataIntegrityService, MemoryHealthService, Phase, PhaseError, PhaseExecutor,
    },
    operations::CycleMetrics,
};

use super::briefing_generation::NativeBriefingGeneration;
use super::profile_consolidation::ProfileConsolidation;

pub(super) struct NativeCyclePhases {
    pub(super) metrics: Arc<CycleMetrics>,
    pub(super) briefing: Arc<NativeBriefingGeneration>,
    pub(super) profile: Arc<ProfileConsolidation>,
    pub(super) box_store: Arc<BoxStoreService>,
    pub(super) legacy_metadata: Arc<LegacyMetadataIntegrityService>,
    pub(super) feedback: Arc<FeedbackBufferService>,
    pub(super) knowhow: Arc<KnowHowService>,
    pub(super) health: Arc<MemoryHealthService>,
}

impl PhaseExecutor for NativeCyclePhases {
    fn execute<'a>(
        &'a self,
        phase: Phase,
        run_id: &'a str,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<Map<String, Value>, PhaseError>> + Send + 'a>> {
        Box::pin(async move {
            match phase {
                Phase::Preflight => Ok(crate::json::json_object!({ "ok": true })),
                Phase::FeedbackTriage => self.profile.feedback_triage(),
                Phase::ProfileConsolidation => self.profile.consolidate(run_id, cancellation).await,
                Phase::BoxIndex => self
                    .box_store
                    .rebuild_index()
                    .await
                    .map(|report| {
                        crate::json::json_object!({
                            "indexed_count": report.indexed_count,
                            "skipped_count": report.skipped_count,
                        })
                    })
                    .map_err(cognition_phase_error),
                Phase::MemoryMetadataIntegrity => self
                    .legacy_metadata
                    .check()
                    .await
                    .map(|report| {
                        crate::json::json_object!({
                            "chunk_count": report.chunk_count,
                            "missing_box_refs_count": report.missing_box_refs_count,
                            "missing_feedback_refs_count": report.missing_feedback_refs_count,
                        })
                    })
                    .map_err(cognition_phase_error),
                Phase::SourceQualityAggregation => self
                    .knowhow
                    .aggregate_and_rebuild()
                    .await
                    .map(|report| {
                        crate::json::json_object!({
                            "source_quality_summary_count": report.source_quality_summary_count,
                            "knowhow_indexed_count": report.knowhow_indexed_count,
                        })
                    })
                    .map_err(cognition_phase_error),
                Phase::KnowhowRevision => {
                    let feedback = self
                        .feedback
                        .active_targets(
                            chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                                .timestamp_millis(),
                        )
                        .await
                        .map_err(cognition_phase_error)?;
                    self.knowhow
                        .revise(&feedback, self.feedback.as_ref())
                        .await
                        .map(|report| {
                            crate::json::json_object!({
                                "revised_knowhow_count": report.revised_knowhow_count,
                                "demoted_knowhow_count": report.demoted_knowhow_count,
                                "applied_feedback_count": report.applied_feedback_count,
                            })
                        })
                        .map_err(cognition_phase_error)
                }
                Phase::MemoryHealth => self
                    .health
                    .read()
                    .await
                    .map(|report| {
                        self.metrics.record(
                            "health",
                            report.metric_status,
                            &report.metric_dimensions,
                        );
                        crate::json::json_object!({
                            "memory_chunks_count": report.memory_chunks_count,
                            "vector_rows_count": report.vector_rows_count,
                            "maintenance_status": report.maintenance_status.as_str(),
                            "diagnostics_count": report.diagnostics_count,
                        })
                    })
                    .map_err(cognition_phase_error),
                Phase::NewChatBriefing => self
                    .briefing
                    .generate(run_id, std::time::SystemTime::now().into(), cancellation)
                    .await
                    .map_err(|error| PhaseError {
                        code: error.code,
                        message: error.message,
                        metrics: Map::new(),
                    }),
                Phase::MetricsSummary => {
                    self.metrics.record(
                        "consolidation_cycle",
                        "ok",
                        &json!({ "raw_text_included": false }),
                    );
                    Ok(crate::json::json_object!({ "raw_text_included": false }))
                }
                Phase::BoxRetention => self
                    .box_store
                    .retention(
                        chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                            .timestamp_millis(),
                    )
                    .await
                    .map(|report| {
                        crate::json::json_object!({
                            "expired_candidate_count": report.expired_candidate_count,
                            "pruned_box_owned_count": report.pruned_box_owned_count,
                        })
                    })
                    .map_err(cognition_phase_error),
            }
        })
    }
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn cognition_phase_error(error: crate::cognition::CognitionError) -> PhaseError {
    PhaseError {
        code: error.code,
        message: error.code.into(),
        metrics: Map::new(),
    }
}

impl CycleEventSink for CycleMetrics {
    fn record(&self, name: &str, status: &str, dimensions: Value) {
        Self::record(self, name, status, &dimensions);
    }
}
