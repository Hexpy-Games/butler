//! Required native effects for the source-configured four-phase memory cycle.

use std::{sync::Arc, time::SystemTime};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::cognition::{
    ConfiguredPhase, ConfiguredPhaseExecutor, ConfiguredPhaseFuture, GraphConsolidationService,
    MemoryHealthService, NativeMemorySyncConsumer, NativeVectorOptimizeService,
    ProjectCapsuleService, VectorOptimizeOutcome,
};

pub(super) struct NativeConfiguredPhases {
    pub consumer: Arc<NativeMemorySyncConsumer>,
    pub consolidate: GraphConsolidationService,
    pub optimize: NativeVectorOptimizeService,
    pub capsules: Arc<ProjectCapsuleService>,
    pub health: MemoryHealthService,
    pub generation_id: String,
    pub activation_decay_d: f64,
    pub project_capsule_refresh_limit: usize,
}

impl ConfiguredPhaseExecutor for NativeConfiguredPhases {
    fn run<'a>(
        &'a self,
        phase: ConfiguredPhase,
        deadline_at_epoch_ms: i64,
        cancellation: &'a CancellationToken,
    ) -> ConfiguredPhaseFuture<'a> {
        Box::pin(async move {
            match phase {
                ConfiguredPhase::Catchup => {
                    let report = self.consumer.catchup_once(cancellation).await?;
                    if report.available && !cancellation.is_cancelled() {
                        // The operator command has no poll loop. Run one bounded
                        // completion quantum through its shared embedding owner.
                        let _ = self.consumer.poll_once().await?;
                    }
                    Ok(json!({
                        "available": report.available,
                        "reason": if report.available { Value::Null } else { json!("canonical_reader_unavailable") },
                        "scanned": report.scanned,
                        "ingested": report.ingested,
                        "wrapped": report.wrapped,
                        "state": {"outcomeCursor":report.outcome_cursor,"recoveredMessageCursor":report.recovered_message_cursor},
                        "generationId":self.generation_id,
                    }))
                }
                ConfiguredPhase::Consolidate => {
                    let now: chrono::DateTime<chrono::Utc> = SystemTime::now().into();
                    self.consolidate
                        .run(
                            &self.generation_id,
                            now.timestamp_millis(),
                            self.activation_decay_d,
                        )
                        .await
                }
                ConfiguredPhase::Optimize => {
                    let outcome = self
                        .optimize
                        .run(cancellation, deadline_at_epoch_ms)
                        .await?;
                    Ok(match outcome {
                        VectorOptimizeOutcome::Unavailable {
                            reason,
                            vectors_pruned,
                        } => {
                            json!({"available":false,"reason":reason,"vectors_pruned":vectors_pruned})
                        }
                        VectorOptimizeOutcome::Metrics {
                            caches_compacted,
                            summaries_re_embedded,
                            vectors_pruned,
                            lancedb_compacted,
                        } => {
                            json!({"caches_compacted":caches_compacted,"summaries_re_embedded":summaries_re_embedded,"vectors_pruned":vectors_pruned,"lancedb_compacted":lancedb_compacted})
                        }
                    })
                }
                ConfiguredPhase::Health => {
                    let capsules = self
                        .capsules
                        .refresh_registered(
                            self.project_capsule_refresh_limit,
                            cancellation,
                            deadline_at_epoch_ms,
                        )
                        .await?;
                    let report = self.health.read().await?;
                    Ok(json!({
                        "memory_chunks_count":report.memory_chunks_count,
                        "vector_rows_count":report.vector_rows_count,
                        "maintenance_status":report.maintenance_status.as_str(),
                        "diagnostics_count":report.diagnostics_count,
                        "project_capsules_considered":capsules.considered,
                        "project_capsules_refreshed":capsules.refreshed,
                        "project_capsule_failures":capsules.failed.len(),
                    }))
                }
            }
        })
    }
}
