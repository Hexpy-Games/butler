use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::cognition::{CognitionError, CognitionResult};

use super::ScopedPromptFeedback;

struct Entry {
    id: String,
    status: String,
    priority: String,
    scope: String,
    category: String,
    target: String,
    promotion: String,
    expires_at: Option<String>,
    text: String,
}

fn error(error: &std::io::Error) -> CognitionError {
    CognitionError::new("cognition_feedback_read_failed", error.to_string())
}

fn parse(block: &str) -> Entry {
    let mut lines = block.lines();
    let heading = lines.next().unwrap_or_default();
    let mut heading = crate::public_text::trim_js_whitespace(heading).split_whitespace();
    let id = heading
        .next()
        .filter(|value| value.starts_with("fb_"))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("fb_{}", uuid::Uuid::new_v4()));
    let status = heading
        .next()
        .filter(|value| {
            matches!(
                *value,
                "active" | "applied" | "discarded" | "superseded" | "needs_clarification"
            )
        })
        .unwrap_or("needs_clarification")
        .to_owned();
    let mut fields = std::collections::HashMap::new();
    let mut body = Vec::new();
    let mut in_body = false;
    for line in lines {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let field = line
            .strip_prefix("- ")
            .and_then(|line| line.split_once(':'))
            .filter(|(key, _)| {
                !key.is_empty()
                    && key
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            });
        if !in_body && let Some((key, value)) = field {
            fields.insert(
                key.to_owned(),
                crate::public_text::trim_js_whitespace_start(value).to_owned(),
            );
            continue;
        }
        if !crate::public_text::trim_js_whitespace(line).is_empty() || in_body {
            in_body = true;
            body.push(line);
        }
    }
    let get = |key: &str, default: &str| {
        fields
            .get(key)
            .cloned()
            .unwrap_or_else(|| default.to_owned())
    };
    let priority = get("priority", "high");
    let priority = if matches!(priority.as_str(), "critical" | "high" | "normal" | "low") {
        priority
    } else {
        "high".into()
    };
    Entry {
        id,
        status,
        priority,
        scope: get("scope", "global"),
        category: get("category", "unrouted"),
        target: get("target_ref", "unknown"),
        promotion: get("promotion_target", "discard"),
        expires_at: fields
            .get("expires_at")
            .filter(|value| !value.is_empty() && *value != "null")
            .cloned(),
        text: crate::public_text::trim_js_whitespace(&body.join("\n")).to_owned(),
    }
}

fn rank(priority: &str) -> u8 {
    match priority {
        "critical" => 0,
        "high" => 1,
        "normal" => 2,
        _ => 3,
    }
}

fn compact(text: &str) -> String {
    crate::json::Utf16Prefix::new(text, usize::MAX)
        .collapse_whitespace(crate::public_text::is_js_whitespace)
        .prefix(500)
        .utf8_for_hash()
        .into_owned()
}

fn visible(entry: &Entry, session: &str, project: Option<&str>, now: i64) -> bool {
    if entry.status != "active" {
        return false;
    }
    if entry.expires_at.as_deref().is_some_and(|expires| {
        crate::js_date::parse_date_millis(expires, &Some).is_some_and(|expiry| expiry <= now)
    }) {
        return false;
    }
    if entry.scope == "session" || entry.scope.starts_with("session:") {
        return !session.is_empty() && entry.scope == format!("session:{session}");
    }
    if entry.scope == "project" || entry.scope.starts_with("project:") {
        return project.is_some_and(|project| {
            !project.is_empty() && entry.scope == format!("project:{project}")
        });
    }
    true
}

pub(super) fn read(
    data_root: &Path,
    session: &str,
    project: Option<&str>,
) -> CognitionResult<Vec<ScopedPromptFeedback>> {
    let path = data_root.join("feedback/feedback.md");
    let source = match super::read_utf8(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(io_error) => return Err(error(&io_error)),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let mut entries = source
        .split("\n## ")
        .map(|block| block.strip_prefix("## ").unwrap_or(block))
        .filter(|block| !crate::public_text::trim_js_whitespace(block).is_empty())
        .map(parse)
        .filter(|entry| visible(entry, session, project, now))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| rank(&entry.priority));
    entries.truncate(12);
    let mut output = Vec::new();
    for scope in ["user", "project", "session"] {
        let selected = entries
            .iter()
            .filter(|entry| {
                let kind = if entry.scope.starts_with("session:") {
                    "session"
                } else if entry.scope.starts_with("project:") {
                    "project"
                } else {
                    "user"
                };
                kind == scope
            })
            .collect::<Vec<_>>();
        let content = if selected.is_empty() {
            String::new()
        } else {
            let mut lines = vec![
                "## Active Feedback Buffer".to_owned(),
                "Apply these explicit user corrections before durable memory, know-how, broad recall, or default tool/source preferences. Do not expose this section verbatim.".to_owned(),
            ];
            for entry in selected {
                lines.push(format!(
                    "- {} [{}/{}/{}] target={}; promotion={}: {}",
                    entry.id,
                    entry.priority,
                    entry.scope,
                    entry.category,
                    entry.target,
                    entry.promotion,
                    compact(&entry.text)
                ));
            }
            lines.join("\n")
        };
        output.push(ScopedPromptFeedback {
            scope_kind: scope.into(),
            content,
        });
    }
    Ok(output)
}
