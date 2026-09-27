use std::path::PathBuf;

use serde_json::Value;

use super::super::contracts::ProjectLedgerRecordUpdate;

#[derive(Clone, Debug)]
pub struct LedgerEffectRequest {
    pub project_root: PathBuf,
    pub effect_key: String,
    pub updates: Vec<ProjectLedgerRecordUpdate>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LedgerEffectReconciliation {
    Applied(Value),
    NotApplied,
    Uncertain,
}

/// Failures of a generic Project Ledger effect. `code()`/`message()` are the
/// wire fields; `Display` is the message.
#[derive(Clone, Debug, thiserror::Error)]
pub enum LedgerEffectError {
    /// The effect occurrence conflicts with an earlier request.
    #[error("{}", self.message())]
    Conflict,
    /// The publication was verified as not applied.
    #[error("{}", self.message())]
    NotApplied,
    /// The publication state could not be verified; `source` is the failed
    /// read, write or encode when there was one.
    #[error("{}", self.message())]
    Uncertain {
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The ledger owner could not finish the effect; the value is its code.
    #[error("{}", self.message())]
    Owner(&'static str),
}

impl LedgerEffectError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Conflict => "project_ledger_effect_occurrence_conflict",
            Self::NotApplied => "project_ledger_effect_not_applied",
            Self::Uncertain { .. } => "project_ledger_effect_uncertain",
            Self::Owner(code) => code,
        }
    }

    /// An unverifiable publication caused by `source`.
    pub(crate) fn uncertain(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::Uncertain {
            source: Some(std::sync::Arc::new(source)),
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::Conflict => "Project Ledger effect occurrence conflicts with an earlier request.",
            Self::NotApplied => "The Project Ledger publication was not applied.",
            Self::Uncertain { .. } => {
                "The Project Ledger publication state could not be verified safely."
            }
            Self::Owner(_) => "The Project Ledger owner could not finish the effect.",
        }
    }
}

/// Wire equality: the same code (causes are diagnostic only).
impl PartialEq for LedgerEffectError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code()
    }
}

impl Eq for LedgerEffectError {}
