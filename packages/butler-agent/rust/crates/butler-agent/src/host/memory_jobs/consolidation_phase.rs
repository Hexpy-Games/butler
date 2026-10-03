//! Required Host phase port: implemented effects or typed unavailable errors.

use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use butler_memory::cognition::{
    KnowHowService, LegacyMetadataIntegrityService, MemoryHealthService, Phase, PhaseError,
    PhaseExecutor,
};
use butler_runtime::operations::CycleMetrics;

use crate::host::memory_jobs::briefing::BriefingGeneration;
use crate::host::memory_jobs::profile_consolidation::ProfileConsolidation;

pub(in crate::host) struct CyclePhases {
    pub(in crate::host) metrics: Arc<CycleMetrics>,
    pub(in crate::host) briefing: Arc<BriefingGeneration>,
    pub(in crate::host) profile: Arc<ProfileConsolidation>,
    pub(in crate::host) legacy_metadata: Arc<LegacyMetadataIntegrityService>,
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
                Phase::FeedbackTriage => self.profile.feedback_triage(cancellation).await,
                Phase::ProfileConsolidation => self.profile.consolidate(run_id, cancellation).await,
                Phase::MemoryMetadataIntegrity => self
                    .legacy_metadata
                    .check()
                    .await
                    .map(|report| {
                        butler_core::json::json_object!({
                            "chunk_count": report.chunk_count,
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
                Phase::KnowhowRevision => Ok(butler_core::json::json_object!({"deferred":true})),
                Phase::MemoryHealth => self
                    .health
                    .read()
                    .await
                    .and_then(|report| {
                        let dimensions = report.metric_dimensions()?;
                        self.metrics
                            .record("health", report.metric_status, &dimensions);
                        Ok(butler_core::json::json_object!({
                            "memory_chunks_count": report.memory_chunks_count,
                            "vector_rows_count": report.vector_rows_count,
                            "maintenance_status": report.maintenance_status.as_str(),
                            "diagnostics_count": report.diagnostics_count,
                        }))
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
            }
        })
    }
}

fn cognition_phase_error(error: butler_memory::cognition::CognitionError) -> PhaseError {
    PhaseError::new(error.code(), error.code()).with_source(error)
}
