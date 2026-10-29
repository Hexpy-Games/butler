//! Held OAuth credential inventory and removal through the admin Security routes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::chatgpt_sign_in::{account, saved, settle, start};
use super::gateway_pairing::support::helpers::admin;
use butler_e2e::e2e::{
    HarnessError,
    fake_chatgpt::FakeChatGptAuthority,
    fixtures,
    gateway::turn_state,
    provider::Script,
    scenario::{Scenario, Setup},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn setup(id: &str, authority: &FakeChatGptAuthority) -> Result<Setup, HarnessError> {
    Ok(Setup::new(id)?
        .without_credential()
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "connected account reply".into(),
        })
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer))
}
async fn listing(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = admin(s)
        .send(Method::GET, "/security/oauth", None, &[])
        .await?;
    assert_eq!(reply.status, 200);
    Ok(reply.data()["credentials"].clone())
}
async fn assert_cleared(s: &Scenario) -> Result<(), HarnessError> {
    assert_eq!(listing(s).await?, json!([]));
    let raw = saved(s)?;
    assert!(raw["access_token"].is_null() && raw["refresh_token"].is_null());
    assert_eq!(account(s).await?["status"], "sign_in_required");
    let missing = admin(s)
        .send(Method::DELETE, "/security/oauth/chatgpt", None, &[])
        .await?;
    assert_eq!(missing.status, 404);
    assert!(missing.text.contains("credential_not_found"));
    Ok(())
}
#[tokio::test]
async fn signed_in_account_removed_stops_future_turns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let s = setup("SEC-OAUTH-SIGN-IN", &authority)?.start().await?;
    s.provider()?.chatgpt_authority(&authority.issuer);
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["status"], "completed");
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
                "provider_id":s.model.provider(), "model_id":s.model.model,
                "auth_type":"chatgpt_oauth"
            }),
        )
        .await?;
    assert!(registered.status < 300);
    assert_eq!(s.gw.get("/security/oauth").await?.status, 403);
    assert_eq!(s.gw.delete("/security/oauth/chatgpt").await?.status, 403);
    let raw = saved(&s)?;
    let obtained = chrono::DateTime::parse_from_rfc3339(raw["signed_in_at"].as_str().unwrap())
        .unwrap()
        .timestamp();
    assert_eq!(
        listing(&s).await?,
        json!([{"id":"chatgpt", "provider":"chatgpt",
        "kind":"sign_in", "label":raw["email"], "obtained_at":obtained,
        "expires_at":null,"revocable":true}])
    );
    let (_, turn) = s.turn("general", "use the connected account").await?;
    assert_eq!(turn_state(&turn), "delivered");
    let reply = admin(&s)
        .send(Method::DELETE, "/security/oauth/chatgpt", None, &[])
        .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data(), &json!({"removed":true,"revoked":true}));
    assert!(authority.seen().iter().any(|r| {
        r.path == "revoke"
            && r.params
                .get("token")
                .is_some_and(|t| raw["refresh_token"].as_str() == Some(t.as_str()))
    }));
    assert_cleared(&s).await?;
    let catalog = s.gw.get("/model-catalog").await?;
    assert_eq!(catalog.status, 200);
    let models = catalog.data()["registered_models"].as_array().unwrap();
    let plan: Vec<_> = models
        .iter()
        .filter(|m| m["auth_type"] == "chatgpt_oauth")
        .collect();
    assert_ne!(plan.len(), 0);
    assert!(plan.iter().all(|m| m["availability"] == "sign_in_required"));
    let before = authority
        .seen()
        .iter()
        .filter(|r| r.path == "token")
        .count();
    let (_, turn) = s.turn("general", "try the removed account").await?;
    assert_eq!(turn_state(&turn), "failed");
    assert!(turn.to_string().contains("chatgpt_sign_in_required"));
    assert_eq!(
        authority
            .seen()
            .iter()
            .filter(|r| r.path == "token")
            .count(),
        before
    );
    s.finish().await
}
#[tokio::test]
async fn legacy_account_removed_without_revocation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let setup = setup("SEC-OAUTH-LEGACY", &authority)?;
    let path = setup.sandbox.data.join("auth/openai-codex.json");
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(
        &path,
        br#"{"access_token":"legacy-access","refresh_token":"legacy-refresh"}"#,
    )?;
    let obtained = std::fs::metadata(&path)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let s = setup.start().await?;
    assert_eq!(
        listing(&s).await?,
        json!([{"id":"chatgpt-legacy","provider":"chatgpt",
        "kind":"legacy_sign_in","label":null,"obtained_at":obtained,"expires_at":null,"revocable":false}])
    );
    let reply = admin(&s)
        .send(Method::DELETE, "/security/oauth/chatgpt-legacy", None, &[])
        .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data(), &json!({"removed":true,"revoked":null}));
    assert!(!path.exists());
    assert_eq!(listing(&s).await?, json!([]));
    assert!(authority.seen().is_empty());
    for id in ["chatgpt-legacy", "unknown"] {
        let missing = admin(&s)
            .send(Method::DELETE, &format!("/security/oauth/{id}"), None, &[])
            .await?;
        assert_eq!(missing.status, 404);
        assert!(missing.text.contains("credential_not_found"));
    }
    s.finish().await
}
#[tokio::test]
async fn hanging_revocation_is_bounded_and_clears_tokens() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    authority.revoke_delay(Duration::from_secs(60));
    let setup = setup("SEC-OAUTH-REVOKE-TIMEOUT", &authority)?;
    fixtures::stub_chatgpt_auth(&setup.sandbox.data, &authority)?;
    let s = setup.start().await?;
    let began = Instant::now();
    let reply = admin(&s)
        .send(Method::DELETE, "/security/oauth/chatgpt", None, &[])
        .await?;
    let elapsed = began.elapsed();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data(), &json!({"removed":true,"revoked":false}));
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_secs(8),
        "hanging revocation removal"
    );
    assert!(authority.seen().iter().any(|r| r.path == "revoke"));
    assert_cleared(&s).await?;
    s.finish().await
}
