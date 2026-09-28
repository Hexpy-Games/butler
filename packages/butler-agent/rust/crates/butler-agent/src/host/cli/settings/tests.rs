use std::{collections::HashMap, path::Path};

use serde_json::json;

use super::config;

#[test]
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
    assert!(config::validate(&value).errors.is_empty());
    value["webSearch"]["provider"] = json!("unsupported");
    assert_eq!(
        config::validate(&value).errors,
        ["webSearch.provider is not supported"]
    );
}

#[test]
fn relative_auth_profile_override_resolves_under_data() {
    let mut environment = HashMap::new();
    environment.insert(
        "BUTLER_CODEX_AUTH_PROFILE".to_owned(),
        "auth/override.json".to_owned(),
    );
    assert_eq!(
        super::path::auth_profile_path(Path::new("/tmp/butler-data"), &environment),
        Path::new("/tmp/butler-data/auth/override.json")
    );
}
