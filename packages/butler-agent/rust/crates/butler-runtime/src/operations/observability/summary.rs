//! Safe diagnostic export and a compact lifecycle summary.

use super::{LogEntry, redact_log_line};

/// Excludes payload-bearing output and preserves redacted operational diagnostics.
pub fn export_line(line: &str) -> Option<String> {
    let marker = line.find('[')?;
    let body = line.get(marker..)?;
    // Only native operational records belong in a support bundle. Model
    // requests, prompts, command output and conversation messages never do.
    if ![
        "[native-app]",
        "[native-butler]",
        "[native-tool]",
        "[native-btcc]",
        "[native-cli]",
        "[native-shutdown]",
        "[native-memory-sync]",
        "[native-memory-sync-catchup]",
        "[native-restart]",
        "[service-lifecycle]",
        "[service-supervisor]",
        "[inbound-queue]",
        "[embedding-semantic]",
    ]
    .iter()
    .any(|prefix| body.starts_with(prefix))
    {
        return None;
    }
    let lower = body.to_ascii_lowercase();
    if [
        "prompt=",
        "content=",
        "input_text",
        "output_text",
        "\"messages\"",
        "conversation=",
    ]
    .iter()
    .any(|field| lower.contains(field))
    {
        return None;
    }
    let line = redact_log_line(line);
    Some(
        if chrono::DateTime::parse_from_rfc3339(line.split_whitespace().next().unwrap_or(""))
            .is_ok()
        {
            line
        } else {
            butler_core::diagnostics::timestamped(&line)
        },
    )
}

/// Produces a support header using only operational lines that passed export filtering.
pub fn log_summary(header: &str, entries: &[LogEntry]) -> String {
    let mut exits = entries
        .iter()
        .filter_map(|entry| export_line(&entry.text))
        .filter(|line| line.contains("[service-lifecycle] event=exit "))
        .collect::<Vec<_>>();
    exits.sort();
    exits.dedup();
    let last_error = entries
        .iter()
        .filter_map(|entry| export_line(&entry.text))
        .filter(|line| log_is_error(line))
        .max()
        .unwrap_or_else(|| "none recorded".into());
    let exits = exits.into_iter().rev().take(5).collect::<Vec<_>>();
    format!(
        "{}\nLast 5 exits (newest first):\n{}\nLast error: {last_error}\nPrivacy: secrets redacted; conversation content excluded.\n",
        redact_log_line(header),
        if exits.is_empty() {
            "none recorded".into()
        } else {
            exits.join("\n")
        }
    )
}

/// Identifies operational errors, including uncatchable process deaths.
pub fn log_is_error(line: &str) -> bool {
    line.contains("interrupted")
        || line.contains("unavailable")
        || line.contains("code=crash_loop_cap")
        || line.contains("exited unexpectedly")
        || (line.contains("[service-lifecycle] event=exit ")
            && !line.contains("code=requested_stop ")
            && !line.contains("code=supervisor_stop "))
}
