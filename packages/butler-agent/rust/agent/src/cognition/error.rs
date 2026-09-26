#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CognitionError {
    pub code: &'static str,
    pub message: String,
}

impl CognitionError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CognitionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CognitionError {}
pub(crate) type CognitionResult<T> = Result<T, CognitionError>;

impl From<super::CognitionSourceError> for CognitionError {
    fn from(error: super::CognitionSourceError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl From<crate::coordination::CoordinationError> for CognitionError {
    fn from(error: crate::coordination::CoordinationError) -> Self {
        Self::new(error.code(), error.message())
    }
}
