use super::*;
use butler_e2e::e2e::agent::Launch;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

async fn command(launch: &Launch, args: &[&str]) -> Result<Value, HarnessError> {
    let mut command = tokio::process::Command::from(launch.command());
    let output = command.args(args).output().await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice::<Value>(&output.stdout)?["data"].clone())
}
async fn login(launch: &Launch, authority: &FakeChatGptAuthority) -> Result<(), HarnessError> {
    let mut command = tokio::process::Command::from(launch.command());
    let mut child = command
        .args(["auth", "login", "--data", launch.data.to_str().unwrap()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    let url = tokio::time::timeout(std::time::Duration::from_secs(20), stdout.next_line())
        .await
        .map_err(|_| butler_e2e::e2e::harness_error("CLI auth URL timeout"))??
        .unwrap();
    assert!(url.starts_with(&authority.issuer));
    assert_eq!(authority.browser(&json!({"auth_url":url})).await?.0, 200);
    let result = stdout.next_line().await?.unwrap();
    assert!(result.contains("e2e-user@example.com") && result.contains("plan on"));
    assert!(child.wait().await?.success());
    Ok(())
}

#[tokio::test]
async fn siwc_07_cli_login_logout_and_status() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let setup = Setup::new("SIWC-07")?;
    let mut launch = Launch::new(&setup.sandbox)?;
    launch.set_env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer);
    launch.set_env("BUTLER_OAUTH_NO_BROWSER", "1");
    launch.set_env("BUTLER_CHATGPT_AUTH_DIR", "private-auth");
    let args = ["auth", "status", "--json"];
    assert_eq!(command(&launch, &args).await?["mode"], "missing");
    let legacy = setup.sandbox.data.join("auth/openai-codex.json");
    std::fs::create_dir_all(legacy.parent().unwrap())?;
    std::fs::write(&legacy, b"legacy-placeholder")?;
    assert_eq!(
        command(&launch, &args).await?["mode"],
        "chatgpt_sign_in_required"
    );
    assert_eq!(
        command(&launch, &["auth", "logout", "--yes", "--json"]).await?["revoked"],
        true
    );
    assert!(!legacy.exists());
    assert!(authority.seen().is_empty());
    launch.set_env("OPENAI_API_KEY", "test-api-key");
    assert_eq!(command(&launch, &args).await?["mode"], "api_key");
    launch.set_env("OPENAI_API_KEY", "");
    login(&launch, &authority).await?;
    assert_eq!(command(&launch, &args).await?["mode"], "chatgpt_plan");
    let path = setup.sandbox.data.join("private-auth/chatgpt.json");
    assert!(path.exists());
    assert!(!setup.sandbox.data.join("auth/chatgpt.json").exists());
    launch.set_env("BUTLER_CHATGPT_AUTH_DIR", "");
    std::fs::write(
        setup.sandbox.data.join(".env"),
        "BUTLER_CHATGPT_AUTH_DIR=private-auth\n",
    )?;
    assert_eq!(command(&launch, &args).await?["mode"], "chatgpt_plan");
    let old: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    let mut plan_off = old.clone();
    plan_off["scopes"] = json!(["openid"]);
    std::fs::write(&path, serde_json::to_vec(&plan_off)?)?;
    let status = command(&launch, &args).await?;
    assert_eq!(status["mode"], "chatgpt_plan_off");
    assert_eq!(status["source"], "chatgpt");
    assert_eq!(
        command(&launch, &["auth", "logout", "--yes", "--json"]).await?["revoked"],
        true
    );
    let seen = authority.seen();
    let revoke = &seen.iter().find(|r| r.path == "revoke").unwrap().params;
    assert!(
        revoke["token"] == old["refresh_token"],
        "wrong revocation token"
    );
    assert_eq!(revoke["client_id"], old["client_id"]);
    assert_eq!(revoke["token_type_hint"], "refresh_token");
    assert_eq!(
        command(&launch, &args).await?["mode"],
        "chatgpt_sign_in_required"
    );
    let before = authority.seen().len();
    assert_eq!(
        command(&launch, &["auth", "logout", "--yes", "--json"]).await?["revoked"],
        true
    );
    assert_eq!(
        authority.seen().len(),
        before,
        "tokenless logout made a request"
    );
    login(&launch, &authority).await?;
    authority.faults(Faults {
        revoke_503: true,
        ..Default::default()
    });
    assert_eq!(
        command(&launch, &["auth", "logout", "--yes", "--json"]).await?["revoked"],
        false
    );
    assert_eq!(
        authority
            .seen()
            .iter()
            .filter(|r| r.path == "revoke")
            .count(),
        4
    );
    let cleared: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    assert!(cleared["access_token"].is_null() && cleared["refresh_token"].is_null());
    assert_eq!(cleared["client_id"], old["client_id"]);
    Ok(())
}
