use std::ffi::OsString;
use std::{collections::HashMap, path::Path};

use serde_json::json;

use super::{config, recognizes};

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn settings_routing_is_exact_and_keeps_model_status_with_status_cli() {
    assert!(recognizes(&args(&["model", "list"])));
    assert!(recognizes(&args(&["--data", "model", "model", "list"])));
    assert!(recognizes(&args(&[
        "--data",
        "/tmp/butler-data",
        "model",
        "set",
        "openai/gpt-6-astra"
    ])));
    assert!(!recognizes(&args(&["model", "status"])));
    assert!(!recognizes(&args(&["model", "anything"])))
}

#[test]
fn config_paths_and_values_preserve_operator_rules() {
    assert!(config::SAFE_CONFIG_PATHS.contains(&"system.defaultModel"));
    assert!(!config::SAFE_CONFIG_PATHS.contains(&"system.apiKey"));
    assert!(config::is_secret_path("provider.api-key"));
    assert!(config::is_secret_path("provider.refreshToken"));
    assert_eq!(config::parse_value("true"), json!(true));
    assert_eq!(config::parse_value("-4.25"), json!(-4.25));
    assert_eq!(config::parse_value(" 1e2 "), json!(" 1e2 "));
}

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
fn config_safe_projection_redacts_nested_values_in_human_arrays() {
    let value = json!([{"refreshToken": "do-not-print"}, "visible"]);
    let projected = config::safe_value(Some(&value));
    let human = config::human_value(Some(&projected));
    assert!(!human.contains("do-not-print"));
    assert!(human.contains("[redacted]"));
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

#[cfg(unix)]
#[test]
fn profile_mutation_paths_reject_symlink_aliases() {
    use std::{fs, os::unix::fs::symlink};

    use super::super::ResolvedInstallation;

    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let install_root = executable.parent().unwrap();
    let installation =
        ResolvedInstallation::desktop(&executable, install_root, install_root).unwrap();
    let root = std::env::temp_dir().join(format!(
        "butler-profile-mutation-paths-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    let data = root.join("data");
    fs::create_dir_all(data.join("inside")).unwrap();
    symlink(data.join("inside"), data.join("personalization")).unwrap();
    assert!(
        super::path::validate_data_mutation_paths(
            &installation,
            &data,
            &["personalization/profile.json"]
        )
        .is_err()
    );

    fs::remove_file(data.join("personalization")).unwrap();
    fs::create_dir(data.join("personalization")).unwrap();
    fs::write(data.join("personalization/inside.json"), b"{}").unwrap();
    symlink(
        data.join("personalization/inside.json"),
        data.join("personalization/profile.json"),
    )
    .unwrap();
    assert!(
        super::path::validate_data_mutation_paths(
            &installation,
            &data,
            &["personalization/profile.json"]
        )
        .is_err()
    );
    fs::remove_dir_all(root).unwrap();
}
