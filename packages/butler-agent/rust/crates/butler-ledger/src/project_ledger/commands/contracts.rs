use std::path::{Path, PathBuf};

use serde_json::Value;

use super::contained_root;

/// A Project Ledger CLI command run on the Ledger owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerCommand {
    /// Summarize the index, counts and next actions.
    Status,
    /// List records of a kind or a derived view.
    Query,
    /// Show one record.
    Show,
    /// Validate records, views and privacy.
    Check,
    /// Rebuild the compact index.
    Index,
    /// Render the dashboard, handoff or roadmap view.
    Render,
    /// Create a top-level record.
    RecordCreate,
    /// Update any record's metadata or body.
    RecordUpdate,
    /// Create a Work record.
    WorkCreate,
    /// Update a Work record.
    WorkUpdate,
    /// Complete a Work record through its gate.
    WorkComplete,
    /// Create a Task under a Work.
    TaskCreate,
    /// Update a Task.
    TaskUpdate,
    /// Complete a Task.
    TaskComplete,
    /// Start an Attempt on a Task.
    AttemptStart,
    /// Mark an Attempt succeeded.
    AttemptSucceed,
    /// Mark an Attempt failed.
    AttemptFail,
}

impl LedgerCommand {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Status => "project-ledger status",
            Self::Query => "project-ledger query",
            Self::Show | Self::RecordCreate | Self::RecordUpdate => "project-ledger record",
            Self::Check => "project-ledger check",
            Self::Index => "project-ledger index",
            Self::Render => "project-ledger render",
            Self::WorkCreate | Self::WorkUpdate | Self::WorkComplete => "project-ledger work",
            Self::TaskCreate | Self::TaskUpdate | Self::TaskComplete => "project-ledger task",
            Self::AttemptStart | Self::AttemptSucceed | Self::AttemptFail => {
                "project-ledger attempt"
            }
        }
    }
}

/// One command with its options, scoped to one Ledger project.
#[derive(Clone, Debug)]
pub struct LedgerCommandRequest {
    /// The Ledger project root the command runs in.
    pub project_root: PathBuf,
    /// The command to run.
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

/// A failed Project Ledger CLI command: the JSON error envelope fields plus
/// the underlying error, which is never printed.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub(super) struct CliFailure {
    pub code: &'static str,
    pub message: String,
    pub details: Box<Value>,
    pub next: Vec<Value>,
    pub data: Box<Value>,
    #[source]
    pub source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl CliFailure {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Box::new(Value::Null),
            next: Vec::new(),
            data: Box::new(Value::Null),
            source: None,
        }
    }

    /// Records the underlying error.
    #[must_use]
    pub(super) fn with_source(
        mut self,
        source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
    ) -> Self {
        self.source = Some(source.into());
        self
    }
}
