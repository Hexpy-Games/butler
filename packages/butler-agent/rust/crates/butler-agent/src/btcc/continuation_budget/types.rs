use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::btcc::BtccError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnContinuationBudgetLimits {
    pub(crate) max_model_requests: u64,
    pub(crate) max_tool_rounds: u64,
    pub(crate) max_model_facing_bytes: u64,
    pub(crate) max_cumulative_model_facing_bytes: u64,
    pub(crate) max_output_bytes: u64,
    pub(crate) max_elapsed_ms: u64,
    pub(crate) max_idle_ms: u64,
    #[serde(flatten)]
    pub(crate) extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnContinuationAdmission {
    pub(crate) round_id: String,
    pub(crate) request_digest: String,
    pub(crate) model_facing_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TurnContinuationBudgetTerminalReason {
    MaxModelRequests,
    MaxToolRounds,
    ModelFacingBytes,
    MaxCumulativeModelFacingBytes,
    MaxOutputBytes,
    MaxElapsedMs,
    MaxIdleMs,
    AdmissionChanged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnContinuationBudgetTerminal {
    pub(crate) code: String,
    pub(crate) reason: TurnContinuationBudgetTerminalReason,
    pub(crate) exhausted_at_ms: u64,
    #[serde(flatten)]
    pub(crate) extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnContinuationBudgetState {
    pub(crate) schema_version: String,
    pub(crate) turn_id: String,
    pub(crate) limits: TurnContinuationBudgetLimits,
    pub(crate) admitted_requests: Vec<TurnContinuationAdmission>,
    pub(crate) completed_output_rounds: Vec<String>,
    pub(crate) completed_tool_rounds: Vec<String>,
    pub(crate) consumed_output_bytes: u64,
    pub(crate) consumed_model_facing_bytes: u64,
    pub(crate) started_at_ms: u64,
    pub(crate) last_progress_at_ms: u64,
    pub(crate) terminal: Option<TurnContinuationBudgetTerminal>,
    #[serde(flatten)]
    pub(crate) extensions: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TurnContinuationBudgetEvent {
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
