//! Gateway and CLI use independent configuration owners on the same DATA.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::fs;

#[tokio::test]
async fn gateway_and_cli_preserve_each_others_config_and_credentials() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("DURABLE-CONFIG")?
        .data_folder_token()
        .start()
        .await?;
    let path = s.sandbox.data.join("butler.config.json");
    let token_path = s
        .sandbox
        .data
        .join("app/runtime/auth/local-agent-auth.json");
    let token_before = fs::read(&token_path)?;
    for _ in 0..4 {
        let launch = s.agent.launch.clone();
        let cli = tokio::task::spawn_blocking(move || {
            launch
                .command()
                .args(["config", "set", "metrics.enabled", "true", "--json"])
                .output()
        });
        let patch = s.gw.patch(
            "/settings",
            json!({"language":"ko","timezone":"Asia/Seoul"}),
        );
        let (cli, reply) = tokio::join!(cli, patch);
        assert!(cli.unwrap()?.status.success(), "config CLI failed");
        assert_eq!(reply?.status, 200);
        let config: Value = serde_json::from_slice(&fs::read(&path)?)?;
        assert_eq!(config["metrics"]["enabled"], true);
        assert_eq!(config["user"]["language"], "ko");
        assert_eq!(config["user"]["timezone"], "Asia/Seoul");
    }
    s.restart().await?;
    assert!(
        fs::read(&token_path)? == token_before,
        "restart replaced a usable credential"
    );
    assert_eq!(s.gw.settings().await?["language"], "ko");
    s.finish().await
}
