use crate::public_text::fixed_regex;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

fn secret_key() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| fixed_regex(r"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization|credential|session[_-]?key)"))
}

fn assignment_patterns() -> &'static [Regex; 4] {
    static VALUE: OnceLock<[Regex; 4]> = OnceLock::new();
    VALUE.get_or_init(|| [
        fixed_regex(r#"(?i)("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|credential|session[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*""#),
        fixed_regex(r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|credential|session[_-]?key)\s*[:=]\s*(?:bearer\s+)?\S+"),
        fixed_regex(r"(?i)\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|PASSWORD|SECRET)[A-Z0-9_]*\s*[:=]\s*\S+"),
        fixed_regex(r"(?i)\bbearer\s+[\w.~+/=-]+"),
    ])
}

pub(super) fn string(value: &str) -> String {
    let patterns = assignment_patterns();
    let value = patterns[0].replace_all(value, "$1\"[REDACTED]\"");
    let value = patterns[1].replace_all(&value, "[REDACTED]");
    let value = patterns[2].replace_all(&value, "[REDACTED]");
    patterns[3]
        .replace_all(&value, "Bearer [REDACTED]")
        .into_owned()
}

pub(super) fn json(value: &Value) -> Value {
    match value {
        Value::String(value) => Value::String(string(value)),
        Value::Array(items) => Value::Array(items.iter().map(json).collect()),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, item) in object {
                output.insert(
                    key.clone(),
                    if key == "secrets_redacted" && item.is_boolean() {
                        item.clone()
                    } else if secret_key().is_match(key) {
                        Value::String("[REDACTED]".into())
                    } else {
                        json(item)
                    },
                );
            }
            Value::Object(output)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn preserves_privacy_boolean_but_redacts_secret_values() {
        let redacted = super::json(&json!({
            "privacy": {"secrets_redacted": true},
            "request": {"api_key": "fixture-secret", "secrets_redacted": "fixture-secret"},
        }));
        assert_eq!(redacted["privacy"]["secrets_redacted"], true);
        assert_eq!(redacted["request"]["api_key"], "[REDACTED]");
        assert_eq!(redacted["request"]["secrets_redacted"], "[REDACTED]");
    }
}
