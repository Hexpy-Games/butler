//! The typed memory health report: metric dimensions, the operator summary
//! and the serving-generation facts inside it. Field order is the JSON
//! order the host records and prints.

use serde::Serialize;

use crate::cognition::generation::HotCacheHealth;
use crate::profile::ProfileCoverageHealth;

/// Dimensions recorded with the `health` metric.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct HealthDimensions {
    /// Hot cache files (`hot/` and `hot/topics/`).
    pub hot_cache_files_count: usize,
    /// Rule files, excluding the index.
    pub rule_files_count: usize,
    /// Queued memory-sync requests.
    pub queue_backlog_count: usize,
    /// Dead-lettered memory-sync requests.
    pub dead_letter_count: usize,
    /// Legacy transcript files.
    pub transcript_files_count: usize,
    /// Legacy task memory entries.
    pub task_memory_entries_count: usize,
    /// Project capsule files.
    pub project_capsules_count: usize,
    /// Registered projects without a capsule.
    pub missing_project_capsules_count: usize,
    /// Legacy vector rows, when a vector snapshot exists.
    pub vector_rows_count: Option<f64>,
    /// Legacy memory chunks.
    pub memory_chunks_count: i64,
    /// Legacy graph entities.
    pub graph_entities_count: i64,
    /// Legacy graph edges.
    pub graph_edges_count: i64,
    /// Legacy graph mentions.
    pub graph_mentions_count: i64,
    /// Newest transcript minus last vector update, in milliseconds.
    pub ingestion_lag_ms: Option<i64>,
    /// The hot cache is missing or older than a week.
    pub stale: bool,
    /// Phases that failed in the last maintenance run.
    pub maintenance_failed_phases_count: usize,
    /// The serving generation could be read.
    pub serving_available: bool,
    /// Always unknown: eligibility needs a complete inventory.
    pub eligible_sources_count: Option<usize>,
    /// Sources registered in the serving graph.
    pub registered_sources_count: Option<i64>,
    /// Always unknown: unknown-origin sources are not counted.
    pub unknown_origin_excluded_count: Option<usize>,
    /// Always unknown: coverage needs a complete inventory.
    pub source_coverage_percent: Option<f64>,
    /// Age of the oldest unfinished projection work.
    pub oldest_pending_age_ms: Option<i64>,
    /// Current windows that failed to resolve their source.
    pub source_resolution_failures_count: Option<i64>,
    /// Current vector units embedded with another model version.
    pub embedding_version_mismatch_count: Option<i64>,
    /// Hot cache entries whose source changed.
    pub cache_stale_entries_count: usize,
    /// Hot cache entries evicted by the budget.
    pub cache_evicted_entries_count: usize,
    /// Profile windows processed (absent without a profile snapshot).
    pub profile_processed_windows_count: Option<usize>,
    /// Profile windows pending (absent without a profile snapshot).
    pub profile_pending_windows_count: Option<usize>,
    /// When maintenance last ran.
    pub maintenance_last_run_at: Option<String>,
    /// Phases that failed in the last maintenance run.
    pub maintenance_failed_phases: Vec<String>,
    /// State of the consolidation writer lock.
    pub writer_gate_status: &'static str,
    /// Why the writer lock is in that state.
    pub writer_gate_reason: Option<&'static str>,
}

/// The `memory_health` tool result and `butler cognition memory-status` data.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthSummary {
    /// The serving generation.
    pub serving: ServingHealth,
    /// The consolidation writer lock.
    pub writer_gate: WriterGate,
    /// Hot cache files.
    pub hot_cache_files: usize,
    /// Rule files.
    pub rule_files: usize,
    /// Queued memory-sync requests.
    pub queue_backlog: usize,
    /// Dead-lettered memory-sync requests.
    pub dead_letter_count: usize,
    /// Legacy transcript files.
    pub transcript_files: usize,
    /// Legacy task memory entries.
    pub task_memory_entries: usize,
    /// Project capsule files.
    pub project_capsules: usize,
    /// Registered projects without a capsule.
    pub missing_project_capsules: usize,
    /// Newest capsule file time.
    pub newest_project_capsule_at: Option<String>,
    /// Recorded capsule refresh failures.
    pub project_refresh_failure_count: usize,
    /// Time of the last capsule refresh failure.
    pub latest_project_refresh_failure_at: Option<String>,
    /// Legacy vector rows.
    pub vector_row_count: Option<f64>,
    /// Legacy memory chunks.
    pub memory_chunk_count: i64,
    /// Legacy graph entities.
    pub graph_entity_count: i64,
    /// Legacy graph edges.
    pub graph_edge_count: i64,
    /// Legacy graph mentions.
    pub graph_mention_count: i64,
    /// Newest transcript minus last vector update, in milliseconds.
    pub ingestion_lag_ms: Option<i64>,
    /// Newest hot cache file time.
    pub newest_hot_cache_at: Option<String>,
    /// Maintenance status name.
    pub maintenance_status: &'static str,
    /// When maintenance last ran.
    pub maintenance_last_run_at: Option<String>,
    /// Phases that failed in the last maintenance run.
    pub maintenance_failed_phases: Vec<String>,
    /// The hot cache is missing or older than a week.
    pub stale: bool,
    /// Human-readable problems.
    pub diagnostics: Vec<String>,
}

/// The consolidation writer lock as the coordinator inspects it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct WriterGate {
    /// Lock state name.
    pub state: &'static str,
    /// Holding process.
    pub pid: Option<u64>,
    /// Holding owner.
    pub owner: Option<crate::coordination::LockInfo>,
    /// Last owner observed.
    pub last_observed_owner: Option<crate::coordination::LockInfo>,
    /// The coordinator database.
    pub coordinator_path: std::path::PathBuf,
    /// Why the lock is in that state.
    pub reason: Option<&'static str>,
}

/// Facts about the active generation's graph, or why it is unavailable.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ServingHealth {
    /// The serving graph could be read consistently.
    pub available: bool,
    /// Why it could not.
    pub reason: Option<&'static str>,
    /// The active generation.
    pub generation_id: Option<String>,
    /// The graph revision read.
    pub graph_revision: Option<i64>,
    /// Source registration and coverage.
    pub sources: ServingSources,
    /// Work items per projection stage.
    pub stages: Stages,
    /// What each stage counts.
    pub stage_units: StageUnits,
    /// Age of the oldest unfinished work.
    pub oldest_pending_age_ms: Option<i64>,
    /// Current windows that failed to resolve their source.
    pub source_resolution_failures: Option<i64>,
    /// Superseded windows that failed to resolve their source.
    pub historical_source_resolution_failures: Option<i64>,
    /// Current vector units embedded with another model version.
    pub embedding_version_mismatch: Option<i64>,
    /// Superseded vector units embedded with another model version.
    pub historical_embedding_version_mismatch: Option<i64>,
    /// Quality operations still pending for this generation.
    pub pending_quality_operations: Option<usize>,
    /// The hot cache.
    pub cache: HotCacheHealth,
    /// The profile extractor's coverage, when the caller read it.
    pub profile: Option<ProfileCoverageHealth>,
}

/// Source registration against the canonical inventory.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct ServingSources {
    /// What is counted (`scalar_source`).
    pub unit: &'static str,
    /// Always unknown.
    pub eligible: Option<usize>,
    /// Eligible sources known from the canonical inventory.
    pub known_eligible: usize,
    /// Registered sources.
    pub registered: Option<i64>,
    /// Registered sources of current, eligible episodes.
    pub registered_current: Option<i64>,
    /// Always unknown.
    pub unknown_origin_excluded: Option<usize>,
    /// Always false: the typed inventory is not read.
    pub inventory_complete: bool,
    /// Why the inventory is incomplete.
    pub inventory_reason: &'static str,
    /// Always unknown.
    pub coverage_percent: Option<f64>,
    /// Coverage of the known eligible sources, in percent.
    pub known_coverage_percent: Option<f64>,
    /// Why coverage is not exact.
    pub coverage_reason: &'static str,
}

/// Work items of each projection stage.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct Stages {
    /// Semantic graph windows.
    pub semantic_graph: StageCount,
    /// Episode vector units.
    pub episode_vectors: StageCount,
    /// Node vector units.
    pub node_vectors: StageCount,
    /// Hot cache projection jobs.
    pub hot_cache: StageCount,
}

/// Work items of one stage by state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub(crate) struct StageCount {
    /// Finished.
    pub complete: i64,
    /// Not finished (any other state).
    pub pending: i64,
    /// Failed.
    pub failed: i64,
    /// Not applicable to this generation.
    pub not_configured: i64,
}

/// What each stage counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct StageUnits {
    /// Always `window_leaf`.
    pub semantic_graph: &'static str,
    /// Always `vector_unit`.
    pub episode_vectors: &'static str,
    /// Always `vector_unit`.
    pub node_vectors: &'static str,
    /// Always `projection_job`.
    pub hot_cache: &'static str,
}

pub(super) const STAGE_UNITS: StageUnits = StageUnits {
    semantic_graph: "window_leaf",
    episode_vectors: "vector_unit",
    node_vectors: "vector_unit",
    hot_cache: "projection_job",
};
