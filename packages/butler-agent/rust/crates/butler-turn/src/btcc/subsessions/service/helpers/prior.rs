//! The prior delegation as the steward's input shows it: its request, status
//! and the start of its result summary. The packet keeps the full context;
//! `read_prior_delegation` returns it.
use serde_json::{Value, json};

/// Summary characters shown inline; about 1.2k tokens of Korean or English.
const SUMMARY_CHARS: usize = 1_200;
const READ_FULL: &str =
    "The full prior request, criteria, result and evidence: read_prior_delegation.";

pub(in crate::btcc::subsessions::service) fn excerpt(prior: Option<&str>) -> String {
    let Some(prior) = prior else {
        return "none".into();
    };
    let Ok(value) = serde_json::from_str::<Value>(prior) else {
        return bounded(prior)
            .map_or_else(|| prior.to_owned(), |head| format!("{head} {READ_FULL}"));
    };
    let result = value.get("result").unwrap_or(&Value::Null);
    let summary = result.get("summary").and_then(Value::as_str).unwrap_or("");
    let shown = bounded(summary);
    let excerpt = json!({
        "relation_id": value.get("relation_id"),
        "request": value.get("request"),
        "status": result.get("status"),
        "summary": shown.as_deref().unwrap_or(summary),
    });
    format!("{excerpt} {READ_FULL}")
}

/// The leading `SUMMARY_CHARS` characters, ending at a line or sentence end
/// when one is near, marked as continuing; `None` when the text fits.
fn bounded(text: &str) -> Option<String> {
    if text.chars().count() <= SUMMARY_CHARS {
        return None;
    }
    let head: String = text.chars().take(SUMMARY_CHARS).collect();
    let cut = head
        .rfind(['\n', '.', '。'])
        .filter(|at| *at >= head.len() / 2)
        .map_or(head.len(), |at| {
            at + head[at..].chars().next().map_or(1, char::len_utf8)
        });
    Some(format!("{} …", head[..cut].trim_end()))
}
