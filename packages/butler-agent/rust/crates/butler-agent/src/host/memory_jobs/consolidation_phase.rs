//! Required Host phase port: implemented effects or typed unavailable errors.

use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use butler_memory::cognition::BoxStoreService;
use butler_memory::cognition::FeedbackBufferService;
use butler_memory::cognition::KnowHowService;
use butler_memory::cognition::LegacyMetadataIntegrityService;
use butler_memory::cognition::MemoryHealthService;
use butler_memory::cognition::Phase;
use butler_memory::cognition::PhaseError;
use butler_memory::cognition::PhaseExecutor;
use butler_runtime::operations::CycleMetrics;

use crate::host::memory_jobs::briefing::BriefingGeneration;
use crate::host::memory_jobs::profile_consolidation::ProfileConsolidation;

pub(in crate::host) struct CyclePhases {
    pub(in crate::host) metrics: Arc<CycleMetrics>,
    pub(in crate::host) briefing: Arc<BriefingGeneration>,
    pub(in crate::host) profile: Arc<ProfileConsolidation>,
    pub(in crate::host) box_store: Arc<BoxStoreService>,
    pub(in crate::host) legacy_metadata: Arc<LegacyMetadataIntegrityService>,
    pub(in crate::host) feedback: Arc<FeedbackBufferService>,
    pub(in crate::host) knowhow: Arc<KnowHowService>,
    pub(in crate::host) health: Arc<MemoryHealthService>,
}

impl PhaseExecutor for CyclePhases {
    fn execute<'a>(
        &'a self,
        phase: Phase,
        run_id: &'a str,
        cancellation: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<Map<String, Value>, PhaseError>> + Send + 'a>> {
        Box::pin(async move {
            match phase {
                Phase::Preflight => Ok(butler_core::json::json_object!({ "ok": true })),
                Phase::FeedbackTriage => self.profile.feedback_triage(),
                Phase::ProfileConsolidation => self.profile.consolidate(run_id, cancellation).await,
                Phase::BoxIndex => self
                    .box_store
                    .rebuild_index()
                    .await
                    .map(|report| {
                        butler_core::json::json_object!({
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
                        butler_core::json::json_object!({
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
                        butler_core::json::json_object!({
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
                            butler_core::json::json_object!({
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
                        butler_core::json::json_object!({
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
                    .map_err(|error| {
                        PhaseError::new(error.code(), error.message()).with_source(error)
                    }),
                Phase::MetricsSummary => {
                    self.metrics.record(
                        "consolidation_cycle",
                        "ok",
                        &json!({ "raw_text_included": false }),
                    );
                    Ok(butler_core::json::json_object!({ "raw_text_included": false }))
                }
                Phase::BoxRetention => self
                    .box_store
                    .retention(
                        chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                            .timestamp_millis(),
                    )
                    .await
                    .map(|report| {
                        butler_core::json::json_object!({
                            "expired_candidate_count": report.expired_candidate_count,
                            "pruned_box_owned_count": report.pruned_box_owned_count,
                        })
                    })
                    .map_err(cognition_phase_error),
            }
        })
    }
}

fn cognition_phase_error(error: butler_memory::cognition::CognitionError) -> PhaseError {
    PhaseError::new(error.code(), error.code()).with_source(error)
}
