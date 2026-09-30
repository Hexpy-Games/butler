//! Retired gateway files remain inert at service startup.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Setup;
use serde_json::Value;

const RETIRED_GATEWAY_FILES: [(&str, &str); 3] = [
    (
        "gateways/telegram.json",
        r#"{"enabled":true,"config":{"botToken":"0000000000:legacy-e2e-dummy","allowedChatIds":[1]}}"#,
    ),
    (
        "auth/telegram-credentials.json",
        r#"{"credentials":[{"kind":"telegram","botToken":"0000000000:legacy-e2e-dummy"}]}"#,
    ),
    (
        "automations/legacy-delivery.json",
        r#"{"id":"legacy","delivery":{"target":"telegram","chatId":1}}"#,
    ),
];

/// MIG-04 — A data folder that still holds a retired chat-app gateway (its
/// settings, credential, a delivery target and a section in
/// `butler.config.json`) starts, passes `doctor`, lists only the `app`
/// gateway, and is left untouched.
#[tokio::test]
async fn mig_04_retired_gateway_files_are_ignored() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("MIG-04")?;
    let data = setup.sandbox.data.clone();
    for (path, body) in RETIRED_GATEWAY_FILES {
        let file = data.join(path);
        std::fs::create_dir_all(file.parent().unwrap())?;
        std::fs::write(file, body)?;
    }
    let mut s = setup.start().await?;
    let config_path = data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["telegram"] =
        serde_json::json!({"enabled": true, "botToken": "0000000000:legacy-e2e-dummy"});
    config["gateways"] = serde_json::json!({"telegram": {"enabled": true}});
    std::fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
    let configured = std::fs::read(&config_path)?;
    s.restart().await?;

    let health = s.gw.get("/health").await?;
    assert_eq!(health.status, 200, "{}", health.text);
    for check in ["data", "credentials"] {
        let doctor = s.agent.cli(&["doctor", "--check", check, "--json"])?;
        assert_eq!(
            doctor.code,
            Some(0),
            "{check}: {} {}",
            doctor.stdout,
            doctor.stderr
        );
    }
    for (path, body) in RETIRED_GATEWAY_FILES {
        assert_eq!(std::fs::read_to_string(data.join(path))?, body, "{path}");
    }
    assert_eq!(std::fs::read(&config_path)?, configured, "config rewritten");
    s.finish().await
}
