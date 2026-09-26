#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CoordinationError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl CoordinationError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CoordinationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CoordinationError {}

pub(crate) type CoordinationResult<T> = Result<T, CoordinationError>;

pub(super) fn unavailable(error: impl std::fmt::Display) -> CoordinationError {
    CoordinationError::new("memory_write_gate_unavailable", error.to_string())
}

pub(super) fn sqlite_error(error: rusqlite::Error) -> CoordinationError {
    if matches!(
        error,
        rusqlite::Error::SqliteFailure(ref value, _)
            if value.code == rusqlite::ErrorCode::DatabaseBusy
    ) {
        CoordinationError::new("memory_write_busy", error.to_string())
    } else {
        unavailable(error)
    }
}
