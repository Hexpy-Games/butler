//! Wire types for the canon queue (`GET /sessions/{id}/canon/queue` and its edits).
use serde::{Deserialize, Serialize};

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:4 CanonQueueOrigin
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) enum CanonQueueOrigin {
    #[serde(rename = "user_message")]
    UserMessage,
    #[serde(rename = "schedule")]
    Schedule,
    #[serde(rename = "detach")]
    Detach,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:8 CanonQueueItem (inline state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CanonQueueItemState {
    Waiting,
    Running,
    Held,
    Done,
    #[serde(other)]
    Unknown,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:117 EpicProgressSnapshot (inline action).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonQueueAction {
    pub(crate) description: String,
    /// "pending" | "active" | "done" | "blocked" | "skipped"
    pub(crate) status: String,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:119 EpicProgressSnapshot (inline counts).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonQueueCounts {
    pub(crate) completed: i64,
    pub(crate) total: i64,
}

/// TS: packages/butler-app/client/shared/canon-contracts.ts:112 EpicProgressSnapshot (the
/// fields the queue reads).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonQueueProgress {
    #[serde(default)]
    pub(crate) actions: Vec<CanonQueueAction>,
    pub(crate) counts: CanonQueueCounts,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:5 CanonQueueItem
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonQueueItem {
    pub(crate) epic_id: String,
    pub(crate) title: String,
    pub(crate) state: CanonQueueItemState,
    #[serde(default)]
    pub(crate) hold_reason: Option<String>,
    #[serde(default)]
    pub(crate) held_by_epic_id: Option<String>,
    pub(crate) progress: CanonQueueProgress,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:15 CanonQueueView (inline step).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonQueueStep {
    #[serde(default)]
    pub(crate) items: Vec<CanonQueueItem>,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:15 CanonQueueView (inline chain).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonQueueChain {
    pub(crate) chain_id: String,
    pub(crate) origin: CanonQueueOrigin,
    #[serde(default)]
    pub(crate) steps: Vec<CanonQueueStep>,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:15 CanonQueueView
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CanonQueueView {
    pub(crate) session_id: String,
    pub(crate) graph_revision: i64,
    #[serde(default)]
    pub(crate) chains: Vec<CanonQueueChain>,
}

/// TS: packages/butler-app/client/shared/canon-queue-contracts.ts:21 CanonQueueEdit. `op` is one
/// of move_to_new_step, join_stack, move_between, split_stack, start_now, delete; the
/// selection is `epic_id` or `epic_ids`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct CanonQueueEdit {
    pub(crate) expected_graph_revision: i64,
    pub(crate) op: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) epic_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) epic_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_epic_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_chain_id: Option<String>,
}
