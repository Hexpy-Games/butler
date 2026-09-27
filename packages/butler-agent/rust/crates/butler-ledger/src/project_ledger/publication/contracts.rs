use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectLedgerRecordKind {
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

/// Whether a record update creates the record or changes an existing one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectLedgerRecordOperation {
    Create,
    Update,
}

/// One record create or update in a Project Ledger publication, as a
/// `project_ledger_create`/`project_ledger_update` call sends it. The core
/// names the record and where it sits; the optional content comes in two
/// flattened groups, so the JSON stays one flat object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLedgerRecordUpdate {
    /// Create or update; an update when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<ProjectLedgerRecordOperation>,
    /// The record id.
    pub id: String,
    /// The record kind; inferred from the existing record when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ProjectLedgerRecordKind>,
    /// The parent record (a task's Work, a managed child's Work).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// The record title.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The record status, in its kind's lifecycle when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// The Markdown body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Dashboard ordering; lower comes first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<f64>,
    /// Text sections of the record.
    #[serde(flatten)]
    pub sections: RecordSections,
    /// Completion evidence and the gates it satisfies.
    #[serde(flatten)]
    pub evidence: RecordEvidence,
}

/// The text sections a record update may set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSections {
    /// The governing spec id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec: Option<String>,
    /// Acceptance criteria.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<String>,
    /// How the result was validated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation: Option<String>,
    /// Review notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
    /// The report path or text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    /// What implements a decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub implementation: Option<String>,
    /// A risk's mitigation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mitigation: Option<String>,
    /// Why the record changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Commit evidence and completion-gate flags a record update may set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordEvidence {
    /// JSON array of `{repo, hash, message}` code commits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_commits: Option<String>,
    /// Ledger commit references.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ledger_commits: Option<String>,
    /// Completing the Work requires code commit evidence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_commit_evidence: Option<bool>,
    /// The Work needs no spec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_exemption: Option<bool>,
}

impl ProjectLedgerRecordUpdate {
    /// An update of `id` that sets nothing yet.
    pub(crate) fn new(id: String) -> Self {
        Self {
            operation: None,
            id,
            kind: None,
            parent_id: None,
            title: None,
            status: None,
            body: None,
            priority: None,
            sections: RecordSections::default(),
            evidence: RecordEvidence::default(),
        }
    }
}

/// A record a publication touches, with its state before publishing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ProjectWorkTarget {
    /// The record id.
    pub id: String,
    /// The record kind.
    pub kind: ProjectLedgerRecordKind,
    /// The record path inside the Ledger project.
    pub path: String,
    /// The parent record id.
    pub parent_id: Option<String>,
    /// Whether the record existed before.
    pub state: ProjectWorkTargetState,
    /// The digest of the record before publishing, when it existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_record_sha256: Option<String>,
}

/// Whether a publication target existed before publishing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectWorkTargetState {
    /// The record did not exist.
    Absent,
    /// The record existed.
    Present,
}

/// What a Project Work publication did.
#[derive(Clone, Debug)]
pub struct ProjectWorkPublicationOutcome {
    /// An earlier attempt of the same operation was replayed.
    pub replayed: bool,
    /// The operation had nothing to publish.
    pub skipped: bool,
    /// The records the publication wrote.
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
pub enum ProjectWorkPublicationError {
    /// The publication request or a stored record was rejected; `code` says
    /// which check failed and `source` is the decode error when there was one.
    #[error("{code}")]
    Adapter {
        /// The failed check.
        code: &'static str,
        /// The decode error, when there was one.
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// Durable work failed.
    #[error(transparent)]
    Work(butler_turn::btcc::BtccError),
    /// The publication was verified as not applied.
    #[error("project_work_publication_not_applied")]
    NotApplied,
    /// The publication state could not be verified.
    #[error("project_work_publication_uncertain")]
    Uncertain {
        /// The failed read, write or decode, when there was one.
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// A ledger file operation failed; `code` names the step.
    #[error("{code}")]
    Io {
        /// The failed step.
        code: &'static str,
        /// The I/O error, when there was one.
        #[source]
        source: Option<std::sync::Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The publication owner could not finish; the value is its code.
    #[error("{0}")]
    Owner(&'static str),
}

impl ProjectWorkPublicationError {
    /// The wire code.
    pub fn code(&self) -> &str {
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
