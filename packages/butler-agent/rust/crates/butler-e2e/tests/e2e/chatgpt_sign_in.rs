//! SIWC P1 public-route acceptance, using only a local authority.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    fake_chatgpt::{FakeChatGptAuthority, Faults},
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
async fn siwc_01_first_registration() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let s = scenario("SIWC-01", &authority).await?;
    assert_eq!(account(&s).await?["status"], "signed_out");
    assert!(!s.sandbox.data.join("auth/chatgpt-host.json").exists());
    for body in [json!({"kind":"unknown"}), json!({"unexpected":true})] {
        assert_eq!(s.gw.post("/setup/oauth/start", body).await?.status, 400);
    }
    let flow = start(&s, json!({})).await?;
    assert_eq!(authority.browser(&flow).await?.0, 200);
    let done = settle(&s, &flow).await?;
    assert_eq!(done["status"], "completed");
    assert_eq!(done["plan_enabled"], true);
    let registration = saved(&s)?;
    assert_ne!(registration["client_id"], "dynamic_agent_client");
    assert!(registration.get("id_token").is_none());
    assert_eq!(account(&s).await?["status"], "signed_in");
    let seen = authority.seen();
    let authorize = &seen.iter().find(|r| r.path == "authorize").unwrap().params;
    assert_eq!(authorize["client_id"], "dynamic_agent_client");
    assert_eq!(authorize["agent_name_hint"], "Butler");
    assert_eq!(authorize["scope"], butler_models::models::chatgpt::SCOPES);
    let token = &seen.iter().find(|r| r.path == "token").unwrap().params;
    assert_eq!(token["client_id"], registration["client_id"]);
    assert_eq!(token["redirect_uri"], flow["redirect_uri"]);
    assert_eq!(token["resource"], butler_models::models::chatgpt::RESOURCE);
    for key in ["access_token", "refresh_token"] {
        assert!(!s.agent.logs().contains(registration[key].as_str().unwrap()));
    }
    let metadata = std::fs::metadata(s.sandbox.data.join("auth/chatgpt.json"))?;
    assert_eq!(
        butler_platform::secure_fs::is_owner_only(&metadata),
        butler_platform::secure_fs::OWNER_ONLY.then_some(true)
    );
    s.finish().await
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
    let host_path = s.sandbox.data.join("auth/chatgpt-host.json");
    std::fs::write(&host_path, b"{}")?;
    let rejected = start(&s, json!({"force":true})).await?;
    assert_eq!(rejected["error"], "oauth_host_unreadable");
    assert_eq!(
        std::fs::read(&host_path)?,
        b"{}",
        "corrupt host was regenerated"
    );
    s.finish().await
}

#[tokio::test]
async fn siwc_03_callback_client_must_match() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let s = scenario("SIWC-03", &authority).await?;
    authority.faults(Faults {
        omit_client: true,
        ..Default::default()
    });
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    assert_eq!(
        settle(&s, &flow).await?["error"],
        "oauth_registration_incomplete"
    );
    authority.faults(Faults::default());
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    settle(&s, &flow).await?;
    let old = saved(&s)?;
    let count = authority
        .seen()
        .iter()
        .filter(|r| r.path == "token")
        .count();
    authority.faults(Faults {
        wrong_client: true,
        ..Default::default()
    });
    let flow = start(&s, json!({"force":true})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["error"], "oauth_client_mismatch");
    assert!(saved(&s)? == old, "failed sign-in changed credentials");
    assert_eq!(
        authority
            .seen()
            .iter()
            .filter(|r| r.path == "token")
            .count(),
        count
    );
    s.finish().await
}

#[tokio::test]
async fn siwc_04_identity_validation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let s = scenario("SIWC-04", &authority).await?;
    for fault in ["signature", "kid", "alg", "iss", "aud", "exp", "nonce"] {
        authority.faults(Faults {
            id_token: Some(fault.into()),
            ..Default::default()
        });
        let before = authority.seen().iter().filter(|r| r.path == "jwks").count();
        let flow = start(&s, json!({"force":true})).await?;
        authority.browser(&flow).await?;
        assert_eq!(
            settle(&s, &flow).await?["error"],
            "oauth_id_token_invalid",
            "{fault}"
        );
        assert!(saved(&s)?["access_token"].is_null());
        if fault == "kid" {
            assert_eq!(
                authority.seen().iter().filter(|r| r.path == "jwks").count(),
                before + 1
            );
        }
    }
    authority.faults(Faults::default());
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    settle(&s, &flow).await?;
    let old = saved(&s)?;
    authority.faults(Faults {
        subject: Some("another-subject".into()),
        ..Default::default()
    });
    let flow = start(&s, json!({"force":true})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["error"], "oauth_account_mismatch");
    assert!(saved(&s)? == old, "failed sign-in changed credentials");
    s.finish().await
}

#[tokio::test]
async fn siwc_05_plan_permission_and_consent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    authority.faults(Faults {
        no_plan: true,
        ..Default::default()
    });
    let s = scenario("SIWC-05", &authority).await?;
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    let done = settle(&s, &flow).await?;
    assert_eq!(done["status"], "completed");
    assert_eq!(done["plan_enabled"], false);
    assert_eq!(account(&s).await?["status"], "plan_off");
    let consent = start(&s, json!({"force":true,"kind":"enable_plan"})).await?;
    let url = url::Url::parse(consent["auth_url"].as_str().unwrap()).unwrap();
    let params = url
        .query_pairs()
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(params["prompt"], "consent");
    assert_eq!(params["scope"], butler_models::models::chatgpt::SCOPES);
    s.finish().await
}

#[tokio::test]
async fn siwc_06_expired_code_keeps_issued_registration() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    authority.faults(Faults {
        invalid_grant: true,
        ..Default::default()
    });
    let s = scenario("SIWC-06", &authority).await?;
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["error"], "oauth_code_expired");
    let client = saved(&s)?["client_id"].clone();
    let next = start(&s, json!({})).await?;
    let url = url::Url::parse(next["auth_url"].as_str().unwrap()).unwrap();
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "client_id")
            .unwrap()
            .1,
        client.as_str().unwrap()
    );
    s.finish().await
}

mod cli;
