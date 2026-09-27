//! The JSON a projection job stores in each `*_state` column: what writers
//! record ([`StageWrite`]) and what readers see ([`StageState`]).

use serde::{Deserialize, Serialize};

use crate::cognition::{CognitionCode, CognitionError, CognitionResult};
use crate::lenient;

/// The lifecycle of one projection stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    /// Waiting to run.
    Pending,
    /// Claimed by a worker.
    Running,
    /// Some units finished, others remain or failed.
    Partial,
    /// Every unit finished.
    Complete,
    /// Stopped with a non-retryable error.
    Failed,
    /// The stage has no configured provider.
    NotConfigured,
}

/// A stage state as a writer records it; each variant keeps its historical
/// key order (`state` first).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(in crate::cognition) enum StageWrite {
    /// Waiting, optionally blocked by a named condition.
    Pending { blocked_by: Option<String> },
    /// Claimed by `owner_pid` for `attempt`.
    Running {
        attempt: i64,
        owner_pid: u32,
        started_at: String,
    },
    /// Some units remain.
    Partial {
        completed_units: i64,
        total_units: i64,
        pending_units: i64,
        failed_units: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        warning_units: Option<i64>,
    },
    /// Every unit finished.
    Complete {
        completed_units: i64,
        total_units: i64,
    },
    /// Stopped with a non-retryable error.
    Failed {
        code: String,
        retryable: bool,
        next_attempt_at: Option<String>,
    },
}

impl StageWrite {
    /// Pending with nothing blocking it.
    pub(in crate::cognition) fn pending() -> Self {
        Self::Pending { blocked_by: None }
    }

    /// Pending until `reason` clears.
    pub(in crate::cognition) fn blocked(reason: &str) -> Self {
        Self::Pending {
            blocked_by: Some(reason.to_owned()),
        }
    }

    /// Complete with `units` of `units` done.
    pub(in crate::cognition) fn complete(units: i64) -> Self {
        Self::Complete {
            completed_units: units,
            total_units: units,
        }
    }

    /// Failed permanently with `code`.
    pub(in crate::cognition) fn failed(code: &str) -> Self {
        Self::Failed {
            code: code.to_owned(),
            retryable: false,
            next_attempt_at: None,
        }
    }

    /// A vector stage: partial once any unit failed or some remain after
    /// progress, complete when every unit finished, pending otherwise.
    pub(in crate::cognition) fn vector_progress(complete: i64, total: i64, failed: i64) -> Self {
        let pending = total - complete - failed;
        if failed > 0 || (complete > 0 && pending > 0) {
            Self::Partial {
                completed_units: complete,
                total_units: total,
                pending_units: pending,
                failed_units: failed,
                warning_units: None,
            }
        } else if complete == total {
            Self::complete(complete)
        } else {
            Self::pending()
        }
    }

    /// The column value.
    pub(in crate::cognition) fn json(&self) -> CognitionResult<String> {
        serde_json::to_string(self).map_err(|error| {
            CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string())
                .with_source(error)
        })
    }
}

/// A stored stage state as readers see it; fields of other types read as
/// absent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct StageState {
    /// The stage lifecycle, when recognised.
    #[serde(default, deserialize_with = "lenient::option")]
    pub state: Option<StageStatus>,
    /// Units finished.
    #[serde(default, deserialize_with = "lenient::option")]
    pub completed_units: Option<i64>,
    /// Units in the stage.
    #[serde(default, deserialize_with = "lenient::option")]
    pub total_units: Option<i64>,
    /// Units still waiting.
    #[serde(default, deserialize_with = "lenient::option")]
    pub pending_units: Option<i64>,
    /// Units that failed.
    #[serde(default, deserialize_with = "lenient::option")]
    pub failed_units: Option<i64>,
    /// What blocks a pending stage.
    #[serde(default, deserialize_with = "lenient::option")]
    pub blocked_by: Option<String>,
    /// Why a failed stage stopped.
    #[serde(default, deserialize_with = "lenient::option")]
    pub code: Option<String>,
}

impl StageState {
    /// Parses a stored column value; unreadable JSON is an unknown state.
    pub(in crate::cognition) fn parse(raw: &str) -> Self {
        lenient::object(raw).unwrap_or_default()
    }

    /// Whether the stage is complete.
    pub fn is_complete(&self) -> bool {
        self.state == Some(StageStatus::Complete)
    }
}
