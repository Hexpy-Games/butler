use serde_json::Value;

pub(super) fn string(value: &str) -> String {
    super::super::log_redaction::redact_log_line(value).replace("[redacted]", "[REDACTED]")
}

pub(super) fn json(value: &Value) -> Value {
    super::super::log_redaction::redact_json(value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    // test-category: security
    #[test]
    fn preserves_privacy_boolean_but_redacts_secret_values() {
        super::super::store::retention_regression();
        let redacted = super::json(&json!({
            "privacy": {"secrets_redacted": true},
            "request": {"api_key": "fixture-secret", "secrets_redacted": "fixture-secret"},
        }));
        let text = super::string(
            "Bearer abc+/= cookie: v2.device.secret\nPairing code=1234 5678 /Users/private-user/log count=42",
        );
        for secret in ["abc+/=", "v2.device.secret", "1234 5678", "private-user"] {
            assert!(!text.contains(secret), "developer text leaked {secret}");
        }
        assert!(text.contains("count=42"));
        assert_eq!(
            super::string("OPENAI_API_KEY=sk-fixture count=42"),
            "OPENAI_API_KEY=[REDACTED] count=42"
        );
        let cookies = super::json(
            &json!({"Cookie": "session=private", "pairing_code": "12345678", "text": "v2.device.secret"}),
        );
        assert_eq!(cookies["Cookie"], "[REDACTED]");
        assert_eq!(cookies["pairing_code"], "[REDACTED]");
        assert_eq!(cookies["text"], "[REDACTED]");
        assert_eq!(redacted["privacy"]["secrets_redacted"], true);
        assert_eq!(redacted["request"]["api_key"], "[REDACTED]");
        assert_eq!(redacted["request"]["secrets_redacted"], "[REDACTED]");
    }
}
