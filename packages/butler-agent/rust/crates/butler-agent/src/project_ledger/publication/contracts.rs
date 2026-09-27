use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProjectLedgerRecordKind {
    Initiative,
    Decision,
    Risk,
    Spec,
    Report,
    Work,
    Task,
    Attempt,
    Plan,
    Handoff,
    Reference,
    Roadmap,
}

impl ProjectLedgerRecordKind {
    pub(in crate::project_ledger) fn as_str(&self) -> &'static str {
        match self {
            Self::Initiative => "initiative",
            Self::Decision => "decision",
            Self::Risk => "risk",
            Self::Spec => "spec",
            Self::Report => "report",
            Self::Work => "work",
            Self::Task => "task",
            Self::Attempt => "attempt",
            Self::Plan => "plan",
            Self::Handoff => "handoff",
            Self::Reference => "reference",
            Self::Roadmap => "roadmap",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProjectLedgerRecordOperation {
    Create,
    Update,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectLedgerRecordUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<ProjectLedgerRecordOperation>,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ProjectLedgerRecordKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub implementation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mitigation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_commits: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ledger_commits: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_commit_evidence: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_exemption: Option<bool>,
}

impl ProjectLedgerRecordUpdate {
    pub(crate) fn new(id: String) -> Self {
        Self {
            operation: None,
            id,
            kind: None,
            parent_id: None,
            title: None,
            status: None,
            body: None,
            spec: None,
            acceptance: None,
            validation: None,
            review: None,
            report: None,
            implementation: None,
            mitigation: None,
            reason: None,
            code_commits: None,
            ledger_commits: None,
            priority: None,
            requires_commit_evidence: None,
            spec_exemption: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectWorkTarget {
    pub id: String,
    pub kind: ProjectLedgerRecordKind,
    pub path: String,
    pub parent_id: Option<String>,
    pub state: ProjectWorkTargetState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_record_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProjectWorkTargetState {
    Absent,
    Present,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkPublicationOutcome {
    pub replayed: bool,
    pub skipped: bool,
    pub targets: Vec<ProjectWorkTarget>,
}

impl ProjectWorkPublicationOutcome {
    pub(super) fn skipped() -> Self {
        Self {
            replayed: false,
            skipped: true,
            targets: Vec::new(),
        }
    }
}

/// Failures publishing Project Work to the ledger. `code()` is the wire code.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum ProjectWorkPublicationError {
    /// The publication request or a stored record was rejected; `code` says
    /// which check failed and `source` is the decode error when there was one.
    #[error("{code}")]
    Adapter {
        code: &'static str,
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// Durable work failed.
    #[error(transparent)]
    Work(crate::btcc::BtccError),
    /// The publication was verified as not applied.
    #[error("project_work_publication_not_applied")]
    NotApplied,
    /// The publication state could not be verified.
    #[error("project_work_publication_uncertain")]
    Uncertain {
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// A ledger file operation failed; `code` names the step.
    #[error("{code}")]
    Io {
        code: &'static str,
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The publication owner could not finish; the value is its code.
    #[error("{0}")]
    Owner(&'static str),
}

impl ProjectWorkPublicationError {
    pub(crate) fn code(&self) -> &str {
        match self {
            Self::Adapter { code, .. } | Self::Io { code, .. } | Self::Owner(code) => code,
            Self::Work(error) => error.code(),
            Self::NotApplied => "project_work_publication_not_applied",
            Self::Uncertain { .. } => "project_work_publication_uncertain",
        }
    }

    pub(crate) fn adapter(code: &'static str) -> Self {
        Self::Adapter { code, source: None }
    }

    pub(crate) fn io(code: &'static str) -> Self {
        Self::Io { code, source: None }
    }

    /// Records `cause` as the source when the variant has an empty slot.
    #[must_use]
    pub(crate) fn with_source(
        mut self,
        cause: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        if let Self::Adapter { source, .. } | Self::Io { source, .. } | Self::Uncertain { source } =
            &mut self
            && source.is_none()
        {
            *source = Some(std::sync::Arc::new(cause));
        }
        self
    }
}

/// Wire equality: the same code (causes are diagnostic only).
impl PartialEq for ProjectWorkPublicationError {
    fn eq(&self, other: &Self) -> bool {
        self.code() == other.code()
    }
}

impl Eq for ProjectWorkPublicationError {}
