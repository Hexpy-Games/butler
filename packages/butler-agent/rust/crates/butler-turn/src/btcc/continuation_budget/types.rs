use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::btcc::BtccError;

/// Limits of a turn's bounded stateless context: requests, tool rounds and bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnContinuationBudgetLimits {
    pub max_model_requests: u64,
    pub max_tool_rounds: u64,
    pub max_model_facing_bytes: u64,
    pub max_cumulative_model_facing_bytes: u64,
    pub max_output_bytes: u64,
    pub max_elapsed_ms: u64,
    pub max_idle_ms: u64,
    #[serde(flatten)]
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// One admitted model request of the budget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnContinuationAdmission {
    pub round_id: String,
    pub request_digest: String,
    pub model_facing_bytes: u64,
}

/// Which limit exhausted the budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnContinuationBudgetTerminalReason {
    MaxModelRequests,
    MaxToolRounds,
    ModelFacingBytes,
    MaxCumulativeModelFacingBytes,
    MaxOutputBytes,
    MaxElapsedMs,
    MaxIdleMs,
    AdmissionChanged,
}

/// The exhaustion of a budget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnContinuationBudgetTerminal {
    pub code: String,
    pub reason: TurnContinuationBudgetTerminalReason,
    pub exhausted_at_ms: u64,
    #[serde(flatten)]
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// A turn's continuation budget (`btcc_turns.continuation_budget_json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnContinuationBudgetState {
    pub schema_version: String,
    pub turn_id: String,
    pub limits: TurnContinuationBudgetLimits,
    pub admitted_requests: Vec<TurnContinuationAdmission>,
    pub completed_output_rounds: Vec<String>,
    pub completed_tool_rounds: Vec<String>,
    pub consumed_output_bytes: u64,
    pub consumed_model_facing_bytes: u64,
    pub started_at_ms: u64,
    pub last_progress_at_ms: u64,
    pub terminal: Option<TurnContinuationBudgetTerminal>,
    #[serde(flatten)]
    // Passthrough: unknown fields kept for forward compatibility.
    pub extensions: Map<String, Value>,
}

/// A change applied to a continuation budget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TurnContinuationBudgetEvent {
    AdmitRequest {
        round_id: String,
        request_digest: String,
        model_facing_bytes: u64,
    },
    RecordOutput {
        round_id: String,
        output_bytes: u64,
    },
    RecordToolRound {
        round_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TurnContinuationBudgetError {
    Invalid(BtccError),
    Exhausted(Box<TurnContinuationBudgetState>),
}
