//! SIWC P1 public-route acceptance, using only a local authority.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    fake_chatgpt::FakeChatGptAuthority,
    scenario::{Fixture, Scenario, Setup},
};
use serde_json::{Value, json};

pub(super) async fn scenario(
    id: &str,
    authority: &FakeChatGptAuthority,
) -> Result<Scenario, HarnessError> {
    Setup::new(id)?
        .fixture(Fixture::Empty)
        .without_credential()
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer)
        .env(
            "BUTLER_CHATGPT_API_BASE_URL",
            format!("{}/v1", authority.issuer),
        )
        .start()
        .await
}
pub(super) async fn start(s: &Scenario, body: Value) -> Result<Value, HarnessError> {
    let reply = s.gw.post("/setup/oauth/start", body).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
pub(super) async fn settle(s: &Scenario, flow: &Value) -> Result<Value, HarnessError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let reply =
            s.gw.get(&format!(
                "/setup/oauth/{}",
                flow["flow_id"].as_str().unwrap()
            ))
            .await?;
        if reply.data()["status"] != "pending" || std::time::Instant::now() > deadline {
            return Ok(reply.data().clone());
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
pub(super) async fn account(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(s.gw.get("/setup/chatgpt-account").await?.data().clone())
}
pub(super) fn saved(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(serde_json::from_slice(&std::fs::read(
        s.sandbox.data.join("auth/chatgpt.json"),
    )?)?)
}

#[tokio::test]
async fn siwc_02_reauthorization_keeps_host_and_client() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let s = scenario("SIWC-02", &authority).await?;
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["status"], "completed");
    let old = saved(&s)?;
    let host = std::fs::read(s.sandbox.data.join("auth/chatgpt-host.json"))?;
    let result =
        s.gw.post("/setup/chatgpt-account/sign-out", json!({}))
            .await?;
    assert_eq!(result.data()["revoked"], true);
    assert!(saved(&s)?["access_token"].is_null());
    let next = start(&s, json!({})).await?;
    authority.browser(&next).await?;
    assert_eq!(settle(&s, &next).await?["status"], "completed");
    let seen = authority.seen();
    let auth = &seen.iter().rfind(|r| r.path == "authorize").unwrap().params;
    assert_eq!(auth["client_id"], old["client_id"]);
    assert_eq!(auth["login_hint"], old["email"]);
    assert!(!auth.contains_key("id_token_hint"));
    assert!(!auth.contains_key("agent_name_hint"));
    assert_eq!(
        std::fs::read(s.sandbox.data.join("auth/chatgpt-host.json"))?,
        host
    );
    assert_eq!(seen.iter().filter(|r| r.path == "discovery").count(), 1);
    s.finish().await
}

mod cli;
