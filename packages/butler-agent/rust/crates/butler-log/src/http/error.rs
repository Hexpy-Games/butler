//! Transport errors retain reqwest's classification; redirect errors are local.
pub enum Error {
    Logging(std::io::Error),
    Transport(reqwest::Error),
    Redirect(String),
    Timeout,
}
impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Self::Transport(error)
    }
}
impl Error {
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Timeout) || matches!(self,Self::Transport(error) if error.is_timeout())
    }
    pub fn is_connect(&self) -> bool {
        matches!(self,Self::Transport(error) if error.is_connect())
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Logging(error) => write!(
                f,
                "HTTP logging unavailable: {}",
                crate::redact_log_line(&error.to_string())
            ),
            Self::Transport(error) => f.write_str(&crate::redact_log_line(&error.to_string())),
            Self::Redirect(message) => {
                write!(f, "redirect refused: {}", crate::redact_log_line(message))
            }
            Self::Timeout => f.write_str("HTTP request timed out"),
        }
    }
}
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Logging(error) => Some(error),
            Self::Transport(error) => Some(error),
            _ => None,
        }
    }
}
