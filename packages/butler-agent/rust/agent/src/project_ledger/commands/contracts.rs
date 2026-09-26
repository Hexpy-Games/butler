use std::path::{Path, PathBuf};

use serde_json::Value;

use super::contained_root;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LedgerCommand {
    Status,
    Query,
    Show,
    Check,
    Index,
    Render,
    RecordCreate,
    RecordUpdate,
    WorkCreate,
    WorkUpdate,
    WorkComplete,
    TaskCreate,
    TaskUpdate,
    TaskComplete,
    AttemptStart,
    AttemptSucceed,
    AttemptFail,
}

impl LedgerCommand {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Status => "project-ledger status",
            Self::Query => "project-ledger query",
            Self::Show => "project-ledger record",
            Self::Check => "project-ledger check",
            Self::Index => "project-ledger index",
            Self::Render => "project-ledger render",
            Self::RecordCreate | Self::RecordUpdate => "project-ledger record",
            Self::WorkCreate | Self::WorkUpdate => "project-ledger work",
            Self::WorkComplete => "project-ledger work",
            Self::TaskCreate | Self::TaskUpdate => "project-ledger task",
            Self::TaskComplete => "project-ledger task",
            Self::AttemptStart | Self::AttemptSucceed | Self::AttemptFail => {
                "project-ledger attempt"
            }
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LedgerCommandRequest {
    pub project_root: PathBuf,
    pub command: LedgerCommand,
    /// Source parseArgs option keys remain dashed; body is an owned inline string.
    pub options: Value,
}

pub(super) struct CommandContext {
    pub root: PathBuf,
}

impl CommandContext {
    pub(super) fn new(data_root: &Path, project_root: &Path) -> Result<Self, CliFailure> {
        Ok(Self {
            root: contained_root(data_root, project_root)?,
        })
    }
}

#[derive(Debug)]
pub(super) struct CliFailure {
    pub code: &'static str,
    pub message: String,
    pub details: Box<Value>,
    pub next: Vec<Value>,
    pub data: Box<Value>,
}

impl CliFailure {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Box::new(Value::Null),
            next: Vec::new(),
            data: Box::new(Value::Null),
        }
    }
}
