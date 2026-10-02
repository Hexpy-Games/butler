//! Change-driven, timestamped operational diagnostics (no conversation payloads).

/// Prefixes each physical line with an ISO UTC timestamp.
pub fn timestamped(message: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    message
        .lines()
        .map(|line| format!("{now} {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Writes an operational diagnostic to stderr with UTC timestamps.
#[macro_export]
macro_rules! diagnostic {
    ($($arg:tt)*) => { eprintln!("{}", $crate::diagnostics::timestamped(&format!($($arg)*))) };
}
