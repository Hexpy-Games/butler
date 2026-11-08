//! The wire shapes of `memoryTypes.ts`, `usePatterns.NoticedPattern` and
//! `ConsolidationStatus`, plus the slice of the settings this page reads and writes.
use serde::Deserialize;

use crate::ui::source::wire::ReasoningEffort;

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Scope {
    pub(super) kind: String,
    #[serde(default)]
    pub(super) project_name: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Instruction {
    pub(super) handle: String,
    pub(super) text: String,
    pub(super) revision: String,
    #[serde(default)]
    pub(super) project_id: Option<String>,
    #[serde(default)]
    pub(super) duration: Option<String>,
    #[serde(default)]
    pub(super) expires_at: Option<String>,
    pub(super) scope: Scope,
}

#[derive(Deserialize)]
pub(super) struct InstructionList {
    pub(super) instructions: Vec<Instruction>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct Health {
    #[serde(default)]
    pub(super) consent_on: Option<bool>,
    #[serde(default)]
    pub(super) reclaimable_bytes: Option<u64>,
    #[serde(default)]
    pub(super) state: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Card {
    pub(super) kind: String,
    #[serde(default)]
    pub(super) item_count: Option<u64>,
    #[serde(default)]
    pub(super) pending_count: Option<u64>,
    #[serde(default)]
    pub(super) allocated_bytes: Option<u64>,
    #[serde(default)]
    pub(super) content_updated_at: Option<String>,
    #[serde(default)]
    pub(super) health: Health,
}

/// A cleanup or reset operation (`MemoryReceipt`).
#[derive(Clone, Debug, Deserialize)]
pub(super) struct Receipt {
    #[serde(default)]
    pub(super) kind: Option<String>,
    pub(super) operation_id: String,
    pub(super) phase: String,
    #[serde(default)]
    pub(super) sequence: u64,
    #[serde(default)]
    pub(super) bytes_reclaimed: u64,
}

impl Receipt {
    pub(super) fn running(&self) -> bool {
        matches!(self.phase.as_str(), "preparing" | "removing")
    }
}

/// `receipt` replaces `current` unless it is an older state of the same operation.
pub(super) fn newer(current: Option<&Receipt>, receipt: &Receipt) -> bool {
    current.is_none_or(|current| {
        current.operation_id != receipt.operation_id || receipt.sequence >= current.sequence
    })
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Inventory {
    pub(super) revision: u64,
    pub(super) kinds: Vec<Card>,
    #[serde(default)]
    pub(super) operation: Option<Receipt>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct ProjectInfo {
    #[serde(default)]
    pub(super) summary_bytes: Option<u64>,
    #[serde(default)]
    pub(super) conversations: Option<u64>,
    #[serde(default)]
    pub(super) instructions: Option<u64>,
    #[serde(default)]
    pub(super) updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct MemoryProject {
    pub(super) id: String,
    pub(super) display_name: String,
}

#[derive(Deserialize)]
pub(super) struct ProjectList {
    pub(super) projects: Vec<MemoryProject>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Evidence {
    pub(super) count: u64,
    pub(super) first_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Pattern {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) evidence: Evidence,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct PatternView {
    pub(super) revision: u64,
    pub(super) patterns: Vec<Pattern>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct ConsolidationReceipt {
    pub(super) operation_id: String,
    pub(super) phase: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct LastRun {
    pub(super) at: String,
    pub(super) status: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct ConsolidationStatus {
    #[serde(default)]
    pub(super) active: Option<ConsolidationReceipt>,
    #[serde(default)]
    pub(super) last_run: Option<LastRun>,
    #[serde(default)]
    pub(super) time_of_day: Option<String>,
}

/// The settings fields this page reads (`draft.*`).
#[derive(Default, Deserialize)]
pub(super) struct MemorySettings {
    pub(super) model: Option<String>,
    pub(super) proactive_level: Option<String>,
    pub(super) quiet_hours_start: Option<String>,
    pub(super) quiet_hours_end: Option<String>,
    pub(super) recall_mode: Option<String>,
    pub(super) recall_judge_model: Option<String>,
    pub(super) consolidation_time: Option<String>,
    pub(super) consolidation_model: Option<String>,
    pub(super) consolidation_reasoning_effort: Option<ReasoningEffort>,
}

/// `GET /setup/readiness` `memory_model` (`MemoryModelProgress`).
#[derive(Clone, Debug, Deserialize)]
pub(super) struct MemoryModel {
    pub(super) state: String,
    #[serde(default)]
    pub(super) bytes_total: u64,
}

#[derive(Deserialize)]
pub(super) struct Readiness {
    #[serde(default)]
    pub(super) memory_model: Option<MemoryModel>,
}
