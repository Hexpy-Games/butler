use std::sync::Arc;

/// Failures of the shared Cognition memory write gate.
///
/// `Display` is the user-facing message (the source's own text for I/O and
/// SQLite failures); `code()` is the persisted wire code.
#[derive(Clone, Debug, thiserror::Error)]
pub(crate) enum CoordinationError {
    /// The caller cancelled writer acquisition while it was waiting.
    #[error("Memory writer acquisition was aborted")]
    Aborted,
    /// SQLite reported the coordinator database busy: another writer holds it.
    #[error("{source}")]
    Busy {
        #[source]
        source: Arc<rusqlite::Error>,
    },
    /// A legacy writer may still be live, so the gate cannot bind its fence.
    #[error("{reason}")]
    LegacyBlocked { reason: &'static str },
    /// The coordinator database or fence failed a consistency check.
    #[error("{detail}")]
    GateInvalid { detail: &'static str },
    /// Reading or writing the coordinator database, fence or host identity failed.
    #[error("{source}")]
    GateIo {
        #[source]
        source: Arc<dyn std::error::Error + Send + Sync>,
    },
}

impl CoordinationError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Aborted => "memory_write_aborted",
            Self::Busy { .. } => "memory_write_busy",
            Self::LegacyBlocked { .. } => "memory_write_legacy_blocked",
            Self::GateInvalid { .. } | Self::GateIo { .. } => "memory_write_gate_unavailable",
        }
    }

    /// The user-facing message; identical to `Display`.
    pub(crate) fn message(&self) -> String {
        self.to_string()
    }

    pub(crate) fn is_busy(&self) -> bool {
        matches!(self, Self::Busy { .. })
    }

    /// Wraps an I/O, SQLite, JSON or host failure of the gate's durable state.
    pub(crate) fn gate_io(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::GateIo {
            source: Arc::new(source),
        }
    }
}

pub(crate) type CoordinationResult<T> = Result<T, CoordinationError>;

pub(super) fn invalid(detail: &'static str) -> CoordinationError {
    CoordinationError::GateInvalid { detail }
}

pub(super) fn sqlite_error(error: rusqlite::Error) -> CoordinationError {
    if super::fence::is_busy(&error) {
        CoordinationError::Busy {
            source: Arc::new(error),
        }
    } else {
        CoordinationError::gate_io(error)
    }
}

#[cfg(test)]
mod wire_tests {
    use std::sync::Arc;

    use super::CoordinationError;

    #[test]
    fn wire_codes_are_stable() {
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        );
        let cases = [
            (CoordinationError::Aborted, "memory_write_aborted"),
            (
                CoordinationError::Busy {
                    source: Arc::new(busy),
                },
                "memory_write_busy",
            ),
            (
                CoordinationError::LegacyBlocked { reason: "r" },
                "memory_write_legacy_blocked",
            ),
            (super::invalid("d"), "memory_write_gate_unavailable"),
            (
                CoordinationError::gate_io(std::io::Error::other("x")),
                "memory_write_gate_unavailable",
            ),
        ];
        for (error, code) in cases {
            assert_eq!(error.code(), code);
        }
    }
}
