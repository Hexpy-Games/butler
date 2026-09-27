//! Failures of Project Ledger reads.

use std::sync::Arc;

/// Failures of Project Ledger reads. `code()` is the wire code; `source`
/// keeps the file, JSON or task error behind the failure when there was one.
#[derive(Clone, Debug, thiserror::Error)]
pub enum ProjectLedgerReadError {
    /// The project or work item could not be resolved.
    #[error("{code}")]
    Resolution {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// A ledger record could not be read or is malformed.
    #[error("{code}")]
    RecordShow {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The read owner is closed or its task failed.
    #[error("{code}")]
    Owner {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// A dashboard projection failed internally.
    #[error("{code}")]
    DashboardInternal {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// Dashboard inputs are unavailable.
    #[error("{code}")]
    DashboardUnavailable {
        code: &'static str,
        #[source]
        source: Option<Arc<dyn std::error::Error + Send + Sync>>,
    },
    /// The ledger changed while the dashboard was being read.
    #[error("project_ledger_changed")]
    DashboardChanged,
}

impl ProjectLedgerReadError {
    pub fn resolution(code: &'static str) -> Self {
        Self::Resolution { code, source: None }
    }

    pub(crate) fn record_show(code: &'static str) -> Self {
        Self::RecordShow { code, source: None }
    }

    pub(crate) fn owner(code: &'static str) -> Self {
        Self::Owner { code, source: None }
    }

    pub(crate) fn dashboard_internal(code: &'static str) -> Self {
        Self::DashboardInternal { code, source: None }
    }

    pub(crate) fn dashboard_unavailable(code: &'static str) -> Self {
        Self::DashboardUnavailable { code, source: None }
    }

    /// The wire code.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Resolution { code, .. }
            | Self::RecordShow { code, .. }
            | Self::Owner { code, .. }
            | Self::DashboardInternal { code, .. }
            | Self::DashboardUnavailable { code, .. } => code,
            Self::DashboardChanged => "project_ledger_changed",
        }
    }

    /// Records `cause` as the source when none is recorded yet.
    #[must_use]
    pub(crate) fn with_source(
        mut self,
        cause: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        if let Self::Resolution { source, .. }
        | Self::RecordShow { source, .. }
        | Self::Owner { source, .. }
        | Self::DashboardInternal { source, .. }
        | Self::DashboardUnavailable { source, .. } = &mut self
            && source.is_none()
        {
            *source = Some(Arc::new(cause));
        }
        self
    }
}

/// Wire equality: the same variant and code (causes are diagnostic only).
impl PartialEq for ProjectLedgerReadError {
    fn eq(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other) && self.code() == other.code()
    }
}

impl Eq for ProjectLedgerReadError {}
