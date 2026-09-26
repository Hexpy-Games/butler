use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub(crate) const CHECKPOINT_SCHEMA: &str = "butler.cognition.consolidation.checkpoint.v1";
pub(crate) const USAGE_RATE_SOURCE: &str = "openai_codex_rate_card_2026_05";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Preflight,
    FeedbackTriage,
    ProfileConsolidation,
    NewChatBriefing,
    BoxIndex,
    MemoryMetadataIntegrity,
    SourceQualityAggregation,
    KnowhowRevision,
    MemoryHealth,
    BoxRetention,
    MetricsSummary,
}

impl Phase {
    pub(crate) const ALL: [Self; 11] = [
        Self::Preflight,
        Self::FeedbackTriage,
        Self::ProfileConsolidation,
        Self::NewChatBriefing,
        Self::BoxIndex,
        Self::MemoryMetadataIntegrity,
        Self::SourceQualityAggregation,
        Self::KnowhowRevision,
        Self::MemoryHealth,
        Self::BoxRetention,
        Self::MetricsSummary,
    ];

    #[cfg(test)]
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Preflight => "preflight",
            Self::FeedbackTriage => "feedback_triage",
            Self::ProfileConsolidation => "profile_consolidation",
            Self::NewChatBriefing => "new_chat_briefing",
            Self::BoxIndex => "box_index",
            Self::MemoryMetadataIntegrity => "memory_metadata_integrity",
            Self::SourceQualityAggregation => "source_quality_aggregation",
            Self::KnowhowRevision => "knowhow_revision",
            Self::MemoryHealth => "memory_health",
            Self::BoxRetention => "box_retention",
            Self::MetricsSummary => "metrics_summary",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CheckpointStatus {
    Running,
    PausedRateLimited,
    Completed,
    CompletedWithErrors,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CycleStatus {
    Completed,
    DeferredRateLimited,
    PausedRateLimited,
    LockHeld,
    CompletedWithErrors,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PhaseResultStatus {
    Ok,
    Error,
    PausedRateLimited,
    DeferredRateLimited,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct CheckpointError {
    pub(crate) phase: Phase,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) resolved_at: Option<String>,
}

impl CheckpointError {
    pub(crate) fn new(phase: Phase, message: impl Into<String>) -> Self {
        Self {
            phase,
            message: message.into(),
            resolved_at: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ActivePhase {
    pub(crate) phase: Phase,
    pub(crate) owner_pid: u32,
    pub(crate) owner_nonce: String,
    pub(crate) started_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Checkpoint {
    pub(crate) schema: String,
    pub(crate) run_id: String,
    pub(crate) status: CheckpointStatus,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) next_phase_index: usize,
    pub(crate) completed_phases: Vec<Phase>,
    pub(crate) errors: Vec<CheckpointError>,
    pub(crate) rate_limit_reset_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) active_phase: Option<ActivePhase>,
}

impl Checkpoint {
    pub(crate) fn new(run_id: &str, started_at: &str) -> Self {
        Self {
            schema: CHECKPOINT_SCHEMA.into(),
            run_id: run_id.into(),
            status: CheckpointStatus::Running,
            created_at: started_at.into(),
            updated_at: started_at.into(),
            next_phase_index: 0,
            completed_phases: Vec::new(),
            errors: Vec::new(),
            rate_limit_reset_at: None,
            active_phase: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct PhaseResult {
    pub(crate) phase: Phase,
    pub(crate) status: PhaseResultStatus,
    #[serde(default)]
    pub(crate) metrics: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

impl PhaseResult {
    pub(crate) fn new(phase: Phase, status: PhaseResultStatus) -> Self {
        Self {
            phase,
            status,
            metrics: Map::new(),
            error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct CycleResult {
    pub(crate) run_id: String,
    pub(crate) status: CycleStatus,
    pub(crate) started_at: String,
    pub(crate) completed_at: Option<String>,
    pub(crate) phases: Vec<PhaseResult>,
    pub(crate) checkpoint_path: String,
    pub(crate) summary_path: String,
    pub(crate) usage: UsageReport,
    pub(crate) raw_text_included: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct RateBudget {
    pub(crate) remaining_ratio: f64,
    pub(crate) reset_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ModelUsageSummary {
    pub(crate) request_count: f64,
    pub(crate) prompt_tokens: f64,
    pub(crate) cached_input_tokens: f64,
    pub(crate) uncached_input_tokens: f64,
    pub(crate) output_tokens: f64,
    pub(crate) total_tokens: f64,
    pub(crate) models: Vec<String>,
    pub(crate) estimated_codex_5_5_credits: f64,
    pub(crate) estimated_api_gpt_5_5_usd: f64,
    pub(crate) rate_source: String,
    pub(crate) raw_text_included: bool,
}

impl ModelUsageSummary {
    pub(crate) fn empty() -> Self {
        Self {
            request_count: 0.0,
            prompt_tokens: 0.0,
            cached_input_tokens: 0.0,
            uncached_input_tokens: 0.0,
            output_tokens: 0.0,
            total_tokens: 0.0,
            models: Vec::new(),
            estimated_codex_5_5_credits: 0.0,
            estimated_api_gpt_5_5_usd: 0.0,
            rate_source: USAGE_RATE_SOURCE.into(),
            raw_text_included: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct PhaseUsageSummary {
    pub(crate) phase: Phase,
    #[serde(flatten)]
    pub(crate) usage: ModelUsageSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct UsageReport {
    #[serde(flatten)]
    pub(crate) usage: ModelUsageSummary,
    pub(crate) phases: Vec<PhaseUsageSummary>,
}
