use crate::public_text::fixed_regex;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

use super::{CliError, Options};

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
pub(super) fn safe_preview(value: Value) -> Value {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(safe_preview_text)
            .unwrap_or_default()
    };
    redact_json_strings(json!({
        "id": value["id"],
        "title": text("title"),
        "session_id": value["session_id"],
        "status": value["status"],
        "schedule": value["schedule"],
        "next_run_at": value["next_run_at"],
        "last_run_at": value["last_run_at"],
        "run_count": value["run_count"],
        "prompt_preview": text("prompt_preview"),
    }))
}

pub(super) fn redact_json_strings(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(safe_preview_text(&value)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_json_strings).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, redact_json_strings(value)))
                .collect(),
        ),
        other => other,
    }
}

fn safe_preview_text(value: &str) -> String {
    static SECRET_FIELD: OnceLock<Regex> = OnceLock::new();
    static SECRET_LABEL: OnceLock<Regex> = OnceLock::new();
    static SECRET_TOKEN: OnceLock<Regex> = OnceLock::new();
    let field = SECRET_FIELD.get_or_init(|| {
        fixed_regex(r"(?i)\b(password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\b(\s*[:=]\s*|\s+is\s+)([^\s,;]+)")
    });
    let label = SECRET_LABEL.get_or_init(|| {
        fixed_regex(r"(?i)\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)[-_][A-Za-z0-9._~-]{4,}")
    });
    let token = SECRET_TOKEN.get_or_init(|| fixed_regex(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b"));
    let redacted = crate::operations::redact_log_line(value);
    let redacted = field.replace_all(&redacted, "$1$2[redacted]");
    let redacted = label.replace_all(&redacted, "[redacted]");
    token.replace_all(&redacted, "[redacted]").into_owned()
}

pub(super) fn report_success(
    options: &Options,
    command: &str,
    data: &Value,
    human: &str,
) -> std::process::ExitCode {
    if options.json {
        println!(
            "{}",
            json!({
                "ok": true,
                "command": command,
                "data": data,
                "error": null,
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else if !options.quiet {
        println!("{human}");
    }
    std::process::ExitCode::SUCCESS
}

pub(super) fn report_error(
    command: &str,
    json_output: bool,
    error: &CliError,
) -> std::process::ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": command,
                "data": null,
                "error": { "code": error.code, "message": error.message },
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else {
        eprintln!("{}", error.message);
    }
    std::process::ExitCode::from(error.exit)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::safe_preview;

    #[test]
    fn preview_keeps_only_safe_fields_and_redacts_secret_patterns() {
        let preview = safe_preview(json!({
            "id": "safe-id",
            "title": "Bearer bearer-secret OPENAI_API_KEY=sk-secret",
            "session_id": "Bearer session-secret",
            "status": "active",
            "schedule": {"type":"once","run_at":"2030-01-01T00:00:00.000Z"},
            "next_run_at": null,
            "last_run_at": null,
            "run_count": 1,
            "prompt_preview": "password is exposed secret-value",
            "prompt": "full prompt must not escape"
        }));
        let rendered = preview.to_string();
        assert!(!rendered.contains("bearer-secret"));
        assert!(!rendered.contains("sk-secret"));
        assert!(!rendered.contains("exposed"));
        assert!(!rendered.contains("secret-value"));
        assert!(!rendered.contains("full prompt"));
        assert!(!rendered.contains("session-secret"));
        assert!(
            preview["prompt_preview"]
                .as_str()
                .unwrap()
                .contains("[redacted]")
        );
    }
}
