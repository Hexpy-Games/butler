//! What an identity decision stored in a projection job's
//! `identity_decisions_json` did.

use serde::{Deserialize, Serialize};

/// The operation of one identity decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum DecisionOperation {
    /// Merged the loser into the canonical node.
    Apply,
    /// An operator undid an apply.
    Revoke,
    /// A new source revision undid a decision that quoted superseded sources.
    Invalidate,
    /// An operation no reader here acts on.
    #[serde(other)]
    Other,
}

impl DecisionOperation {
    /// Whether the decision undid an earlier one.
    pub(super) fn undoes(self) -> bool {
        matches!(self, Self::Revoke | Self::Invalidate)
    }
}
