use std::path::PathBuf;

use serde_json::Value;

use super::super::contracts::ProjectLedgerRecordUpdate;

#[derive(Clone, Debug)]
pub(crate) struct LedgerEffectRequest {
    pub project_root: PathBuf,
    pub effect_key: String,
    pub updates: Vec<ProjectLedgerRecordUpdate>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum LedgerEffectReconciliation {
    Applied(Value),
    NotApplied,
    Uncertain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LedgerEffectError {
    Conflict,
    NotApplied,
    Uncertain,
    Owner(&'static str),
}

impl LedgerEffectError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Conflict => "project_ledger_effect_occurrence_conflict",
            Self::NotApplied => "project_ledger_effect_not_applied",
            Self::Uncertain => "project_ledger_effect_uncertain",
            Self::Owner(code) => code,
        }
    }

    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Conflict => "Project Ledger effect occurrence conflicts with an earlier request.",
            Self::NotApplied => "The Project Ledger publication was not applied.",
            Self::Uncertain => "The Project Ledger publication state could not be verified safely.",
            Self::Owner(_) => "The Project Ledger owner could not finish the effect.",
        }
    }
}
