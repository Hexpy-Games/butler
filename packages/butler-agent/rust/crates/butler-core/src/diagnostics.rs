//! Change-driven, timestamped operational diagnostics (no conversation payloads).

static REDACTOR: std::sync::OnceLock<fn(&str) -> String> = std::sync::OnceLock::new();
/// Installs the process-wide credential scrubber for diagnostic stderr output.
pub fn set_redactor(redactor: fn(&str) -> String) {
    let _ = REDACTOR.set(redactor);
}

/// Prefixes each physical line with an ISO UTC timestamp.
pub fn timestamped(message: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let message = REDACTOR
        .get()
        .map_or_else(|| message.to_owned(), |redact| redact(message));
    message
        .lines()
        .map(|line| format!("{now} {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Sends diagnostics through the installed registry without changing call sites.
pub fn event(message: &str) {
    tracing::info!(target: "butler.diagnostic", category="lifecycle", event="diagnostic", message);
}

/// Writes an operational diagnostic to stderr with UTC timestamps.
#[macro_export]
macro_rules! diagnostic {
    ($($arg:tt)*) => {{
        let message = format!($($arg)*);
        $crate::diagnostics::event(&message);
        eprintln!("{}", $crate::diagnostics::timestamped(&message));
    }};
}
