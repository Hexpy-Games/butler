//! Safe config writes use the same reply-language values as the App API.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, agent::Launch, sandbox::Sandbox};
use serde_json::Value;

#[test]
fn config_reply_language_set_get_is_explicit_and_validated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::new("CLI-REPLY-LANGUAGE")?;
    let launch = Launch::new(&sandbox)?;
    let output = launch
        .command()
        .args(["config", "set", "user.language", "ko", "--json"])
        .output()?;
    assert!(output.status.success());
    let config: Value =
        serde_json::from_slice(&std::fs::read(sandbox.data.join("butler.config.json"))?)?;
    assert_eq!(config["user"], serde_json::json!({"language":"ko"}));
    for language in ["ko", "en"] {
        let output = launch
            .command()
            .args(["config", "set", "user.responseLanguage", language, "--json"])
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let output = launch
            .command()
            .args(["config", "get", "user.responseLanguage", "--json"])
            .output()?;
        assert!(output.status.success());
        let view: Value = serde_json::from_slice(&output.stdout)?;
        assert_eq!(view["data"]["value"], language);
        let config: Value =
            serde_json::from_slice(&std::fs::read(sandbox.data.join("butler.config.json"))?)?;
        assert_eq!(config["user"]["responseLanguageDefaultSource"], "explicit");
    }
    for invalid in ["ja", "true", "1", "KO", " en "] {
        let output = launch
            .command()
            .args(["config", "set", "user.responseLanguage", invalid, "--json"])
            .output()?;
        assert!(!output.status.success(), "accepted {invalid}");
    }
    let output = launch
        .command()
        .args(["config", "set", "user.language", "ko", "--json"])
        .output()?;
    assert!(output.status.success());
    let output = launch
        .command()
        .args(["config", "get", "user.responseLanguage", "--json"])
        .output()?;
    let view: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(view["data"]["value"], "en");
    sandbox.mark_success();
    Ok(())
}
