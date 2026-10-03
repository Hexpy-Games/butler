//! Cassette hygiene (PROVIDER_CONFIG.md §4.2): every committed cassette was
//! written by the recorder (hashes match `meta.json`) and holds no secrets,
//! personal paths, account ids or canaries.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::path::Path;

use butler_e2e::e2e::cassette::{self, load_from};
use butler_e2e::e2e::sanitize;

fn scenario_dirs(root: &Path, prefix: &str, out: &mut Vec<(String, std::path::PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
        if path.join("meta.json").is_file() {
            out.push((name.clone(), path.clone()));
        }
        scenario_dirs(&path, &format!("{name}/"), out);
    }
}

// test-category: security
#[test]
fn cassettes_are_recorder_written_and_sanitized() {
    let root = cassette::root();
    let mut dirs = Vec::new();
    scenario_dirs(&root, "", &mut dirs);
    let mut findings = Vec::new();
    for (name, dir) in &dirs {
        match load_from(dir, name) {
            Ok(loaded) => {
                if loaded.meta.recorded_at.is_empty() || loaded.meta.provider.is_empty() {
                    findings.push(format!("{name}: meta lacks provenance"));
                }
            }
            Err(error) => findings.push(format!("{name}: {error}")),
        }
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let text = fs::read_to_string(entry.path()).unwrap_or_default();
            for finding in sanitize::lint(&text) {
                findings.push(format!(
                    "{name}/{}: {finding}",
                    entry.file_name().to_string_lossy()
                ));
            }
        }
    }
    assert!(
        findings.is_empty(),
        "cassette lint failed:\n{}",
        findings.join("\n")
    );
}

/// The lint rejects every shape an identifier or secret has taken in usage
/// and token replies, raw or JSON-string-escaped inside a cassette.
// test-category: security
#[test]
fn lint_rejects_identifiers_tokens_keys_and_reset_times() {
    let body = |value: serde_json::Value| {
        serde_json::json!({"response": {"chunks": [{"text": value.to_string()}]}}).to_string()
    };
    let rejected = [
        (
            "numeric account id",
            body(serde_json::json!({"account_id": 12_345_678})),
        ),
        (
            "chatgpt_account_id",
            body(serde_json::json!({"chatgpt_account_id": "a1b2c3"})),
        ),
        ("orgId", body(serde_json::json!({"orgId": "org-abc"}))),
        (
            "organizationId",
            body(serde_json::json!({"organizationId": "abc"})),
        ),
        (
            "bare id, account",
            body(serde_json::json!({"id": "user-abcdef"})),
        ),
        (
            "bare id, number",
            body(serde_json::json!({"id": 98_765_432})),
        ),
        (
            "escaped value",
            r#"{"text": "{\"account_id\":\"\\u0061bc\"}"}"#.to_owned(),
        ),
        (
            "SSE data line",
            serde_json::json!({"response": {"chunks": [{"text": "data: {\"user_id\":\"u1\"}\n\n"}]}})
                .to_string(),
        ),
        (
            "refresh token",
            body(serde_json::json!({"refresh_token": "rt_abc"})),
        ),
        ("id token", body(serde_json::json!({"id_token": "opaque"}))),
        (
            "Z.AI key",
            "key 0123456789abcdef0123456789abcdef.AbCdEfGh12345678".to_owned(),
        ),
        (
            "bare Authorization",
            r#"[["authorization", "0123456789abcdef.ghij"]]"#.to_owned(),
        ),
        (
            "Authorization field",
            body(serde_json::json!({"Authorization": "abc"})),
        ),
        (
            "uuid",
            "\"session\": \"3f2504e0-4f89-11d3-9a0c-0305e82c3301\"".to_owned(),
        ),
        (
            "absolute reset",
            body(serde_json::json!({"nextResetTime": 1_790_906_806_983_i64})),
        ),
        (
            "absolute reset_at",
            body(serde_json::json!({"reset_at": 1_791_095_754})),
        ),
    ];
    for (case, text) in &rejected {
        assert!(!sanitize::lint(text).is_empty(), "{case}: {text}");
    }
    let accepted = [
        body(serde_json::json!({"account_id": "{{ACCOUNT}}", "email": "{{EMAIL}}"})),
        body(serde_json::json!({"id": "resp_0168305ded1acae4", "refresh_token": "{{TOKEN}}"})),
        body(
            serde_json::json!({"nextResetTime": "{{EPOCH_MS+313200000}}", "reset_after_seconds": 3600}),
        ),
        r#"{"prompt_cache_key":"3f2504e0-4f89-11d3-9a0c-0305e82c3301"}"#.to_owned(),
        r#"[["authorization", "Bearer {{TOKEN}}"]]"#.to_owned(),
    ];
    for text in &accepted {
        assert!(
            sanitize::lint(text).is_empty(),
            "{text}: {:?}",
            sanitize::lint(text)
        );
    }
}
