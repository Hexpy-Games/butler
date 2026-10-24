use std::{collections::HashMap, path::Path};

use serde_json::json;

use super::config;

// test-category: pure-logic
#[test]
fn config_paths_and_values_preserve_operator_rules() {
    config_update_keeps_unrelated_values_and_validation_checks_whole_object();
    assert!(config::SAFE_CONFIG_PATHS.contains(&"system.defaultModel"));
    assert!(!config::SAFE_CONFIG_PATHS.contains(&"system.apiKey"));
    assert!(config::SAFE_CONFIG_PATHS.contains(&"webSearch.planning.model"));
    assert!(config::SAFE_CONFIG_PATHS.contains(&"webSearch.planning.reasoningEffort"));
    let good =
        json!({"webSearch":{"planning":{"model":"openai/gpt-6-luna","reasoningEffort":"low"}}});
    assert_eq!(config::validate(&good).errors, Vec::<String>::new());
    let bad = json!({"webSearch":{"planning":{"model":" ","reasoningEffort":"invalid"}}});
    assert_eq!(config::validate(&bad).errors.len(), 2);
    assert!(config::is_secret_path("provider.api-key"));
    assert!(config::is_secret_path("provider.refreshToken"));
    assert_eq!(config::parse_value("true"), json!(true));
    assert_eq!(config::parse_value("-4.25"), json!(-4.25));
    assert_eq!(config::parse_value(" 1e2 "), json!(" 1e2 "));
}

fn config_update_keeps_unrelated_values_and_validation_checks_whole_object() {
    let mut value = json!({
        "unknown": { "retained": true },
        "system": "legacy",
        "metrics": { "enabled": true }
    });
    config::set_path(
        &mut value,
        "system.defaultModel",
        json!("openai/gpt-6-astra"),
    );
    assert_eq!(value["unknown"]["retained"], true);
    assert_eq!(value["system"]["defaultModel"], "openai/gpt-6-astra");
    assert_eq!(
        config::validate(&value).errors,
        [] as [std::string::String; 0]
    );
    value["webSearch"]["provider"] = json!("unsupported");
    assert_eq!(
        config::validate(&value).errors,
        ["webSearch.provider is not supported"]
    );
}

#[test]
fn config_safe_projection_redacts_nested_values_in_human_arrays() {
    let value = json!([{"refreshToken": "do-not-print"}, "visible"]);
    let projected = config::safe_value(Some(&value));
    let human = config::human_value(Some(&projected));
    assert!(!human.contains("do-not-print"));
    assert!(human.contains("[redacted]"));
}

#[test]
fn chatgpt_auth_directory_override_is_shared() {
    let data = Path::new("/tmp/butler-data");
    assert_eq!(
        super::path::auth_profile_path(data, &HashMap::new()),
        data.join("auth/chatgpt.json")
    );
    for (directory, expected) in [
        ("/tmp/chatgpt-auth", "/tmp/chatgpt-auth/chatgpt.json"),
        ("private-auth", "/tmp/butler-data/private-auth/chatgpt.json"),
    ] {
        let environment =
            HashMap::from([("BUTLER_CHATGPT_AUTH_DIR".to_owned(), directory.to_owned())]);
        assert_eq!(
            super::path::auth_profile_path(data, &environment),
            Path::new(expected)
        );
    }
}
