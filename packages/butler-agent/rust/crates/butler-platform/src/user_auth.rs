//! Asking the person at this computer to prove they are its user before a
//! secret is shown: Touch ID or the login password on macOS, Windows Hello
//! (or the Windows sign-in password) on Windows. Other systems have no such
//! prompt here and report [`UserAuthError::Unavailable`].
//!
//! [`verify`] blocks until the user answers (or `timeout` passes); async
//! callers run it on a blocking thread. A test harness sets
//! [`DENY_VARIABLE`] to `deny` so no prompt ever appears and every request is
//! refused; the variable can only make the answer stricter.

use std::time::Duration;

/// The environment variable a test harness sets to `deny`: never prompt,
/// always refuse.
pub const DENY_VARIABLE: &str = "BUTLER_USER_AUTH";

/// Why the user was not verified. No variant carries user input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum UserAuthError {
    /// This system has no user prompt (or none is set up: no password, no
    /// Windows Hello, no Touch ID and no password fallback).
    #[error("user verification is unavailable")]
    Unavailable,
    /// The user did not prove who they are (wrong credential, too many tries,
    /// or the harness denies every request).
    #[error("user verification failed")]
    Denied,
    /// The user or the system dismissed the prompt.
    #[error("user verification was canceled")]
    Canceled,
    /// Nobody answered within the timeout.
    #[error("user verification timed out")]
    Timeout,
}

impl UserAuthError {
    /// A stable code: `unavailable`, `denied`, `canceled` or `timeout`.
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Denied => "denied",
            Self::Canceled => "canceled",
            Self::Timeout => "timeout",
        }
    }
}

/// Whether this system can ask its user at all (without asking now).
pub fn available() -> bool {
    cfg!(any(target_os = "macos", windows))
}

/// Asks the user to verify themselves with `reason` shown in the prompt.
pub fn verify(reason: &str, timeout: Duration) -> Result<(), UserAuthError> {
    if std::env::var(DENY_VARIABLE).is_ok_and(|value| value.trim().eq_ignore_ascii_case("deny")) {
        return Err(UserAuthError::Denied);
    }
    if reason.trim().is_empty() {
        return Err(UserAuthError::Unavailable);
    }
    native::verify(reason, timeout)
}

#[cfg(any(target_os = "macos", windows))]
mod native {
    use super::UserAuthError;
    use robius_authentication::{AndroidText, Context, Error, PolicyBuilder, Text, WindowsText};
    use std::time::Duration;

    /// Biometrics with the account password as the fallback
    /// (`LAPolicyDeviceOwnerAuthentication` on macOS; Windows Hello, else the
    /// Windows credential prompt).
    pub(super) fn verify(reason: &str, timeout: Duration) -> Result<(), UserAuthError> {
        let policy = PolicyBuilder::new()
            .build()
            .ok_or(UserAuthError::Unavailable)?;
        let text = Text {
            android: AndroidText {
                title: "Butler",
                subtitle: None,
                description: None,
            },
            apple: reason,
            windows: WindowsText::new_truncated("Butler", reason),
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        Context::new(())
            .authenticate(text, &policy, move |result| {
                let _ = sender.send(result);
            })
            .map_err(|error| convert(&error))?;
        match receiver.recv_timeout(timeout) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(convert(&error)),
            Err(_) => Err(UserAuthError::Timeout),
        }
    }

    fn convert(error: &Error) -> UserAuthError {
        match error {
            Error::UserCanceled | Error::AppCanceled | Error::SystemCanceled => {
                UserAuthError::Canceled
            }
            Error::Authentication | Error::Exhausted | Error::UserFallback => UserAuthError::Denied,
            Error::Timeout => UserAuthError::Timeout,
            _ => UserAuthError::Unavailable,
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod native {
    use super::UserAuthError;
    use std::time::Duration;

    pub(super) fn verify(_: &str, _: Duration) -> Result<(), UserAuthError> {
        Err(UserAuthError::Unavailable)
    }
}
