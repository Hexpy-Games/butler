//! First-run setup (#230): the ChatGPT sign-in flow the agent owns.
//! `POST /setup/oauth/start` returns a `flow_id` and opens a localhost
//! callback listener; `POST /setup/oauth/{flow_id}/cancel` closes it and
//! drops the PKCE state, and the flow reports `cancelled`. The browser is
//! played by the test; the token endpoint is a loopback stand-in
//! (`BUTLER_CODEX_OAUTH_TOKEN_URL`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::free_port;
use butler_e2e::e2e::fake_servers::{
    FakeServer, OAUTH_ACCOUNT_ID, OAUTH_EMAIL, base64url, form_value,
};
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

async fn with_callback_port(id: &str, token: &FakeServer) -> Result<(Scenario, u16), HarnessError> {
    let port = free_port()?;
    let s = Setup::new(id)?
        .fixture(Fixture::Empty)
        .without_credential()
        .env("BUTLER_CODEX_OAUTH_PORT", port.to_string())
        .env(
            "BUTLER_CODEX_OAUTH_TOKEN_URL",
            format!("{}/oauth/token", token.base_url),
        )
        .start()
        .await?;
    Ok((s, port))
}

async fn start(gw: &Gateway, body: Value) -> Result<Value, HarnessError> {
    let reply = gw.post("/setup/oauth/start", body).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

/// The `name` query parameter of the flow's authorization URL.
fn auth_param(flow: &Value, name: &str) -> String {
    let url = flow["auth_url"].as_str().unwrap();
    let query = url.split_once('?').unwrap().1;
    form_value(query, name).unwrap().to_owned()
}

fn listening(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// The browser's redirect to the callback listener.
async fn callback(port: u16, query: &str) -> Result<(u16, String), HarnessError> {
    let response = reqwest::get(format!("http://127.0.0.1:{port}/auth/callback?{query}")).await?;
    Ok((response.status().as_u16(), response.text().await?))
}

async fn flow_until(gw: &Gateway, flow_id: &str, status: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let reply = gw.get(&format!("/setup/oauth/{flow_id}")).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        if reply.data()["status"] == status || Instant::now() > deadline {
            return Ok(reply.data().clone());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// SETUP-08 — Cancelling a pending sign-in closes its callback listener
/// and drops its PKCE state: the flow reports `cancelled`, the port is
/// free, and a later callback with that state cannot complete anything.
#[tokio::test]
async fn setup_08_cancel_closes_the_listener_and_drops_the_state() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeServer::oauth_token().await?;
    let (s, port) = with_callback_port("SETUP-08", &token).await?;
    let flow = start(&s.gw, json!({})).await?;
    assert_eq!(flow["status"], "pending", "{flow}");
    let flow_id = flow["flow_id"].as_str().unwrap().to_owned();
    assert_eq!(
        flow["redirect_uri"],
        format!("http://localhost:{port}/auth/callback"),
        "{flow}"
    );
    assert_eq!(auth_param(&flow, "code_challenge_method"), "S256");
    let state = auth_param(&flow, "state");
    assert!(listening(port), "no callback listener while pending");
    // A second start returns the pending flow instead of a new listener.
    assert_eq!(start(&s.gw, json!({})).await?["flow_id"], flow_id.as_str());

    let cancel =
        s.gw.post(&format!("/setup/oauth/{flow_id}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 200, "{}", cancel.text);
    assert_eq!(cancel.data()["flow_id"], flow_id.as_str());
    assert_eq!(cancel.data()["status"], "cancelled");
    assert!(
        !listening(port),
        "the callback listener outlived the cancel"
    );
    assert_eq!(
        s.gw.get(&format!("/setup/oauth/{flow_id}")).await?.data()["status"],
        "cancelled"
    );
    let late = callback(port, &format!("code=late&state={state}")).await;
    assert!(
        late.is_err(),
        "a callback reached a cancelled flow: {late:?}"
    );
    assert!(token.seen().is_empty(), "a cancelled flow exchanged a code");
    let again =
        s.gw.post(&format!("/setup/oauth/{flow_id}/cancel"), json!({}))
            .await?;
    assert_eq!(again.data()["status"], "cancelled", "{}", again.text);
    let unknown =
        s.gw.post("/setup/oauth/oauth_unknown/cancel", json!({}))
            .await?;
    assert_eq!(unknown.status, 404, "{}", unknown.text);
    assert_eq!(unknown.error_code(), Some("oauth_flow_not_found"));

    // The port is free again: a new sign-in listens on it.
    let next = start(&s.gw, json!({})).await?;
    assert_ne!(next["flow_id"], flow_id.as_str());
    assert!(listening(port));
    let next_id = next["flow_id"].as_str().unwrap();
    s.gw.post(&format!("/setup/oauth/{next_id}/cancel"), json!({}))
        .await?;
    s.finish().await
}

/// RFC 7636 S256: base64url (no padding) of SHA-256 of the verifier.
fn s256(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// SETUP-09 — A sign-in completes when the browser returns with this
/// flow's state: the code is exchanged with the verifier whose S256 is the
/// flow's challenge, the sign-in is saved under the account the token
/// names, the listener closes, and a new start reports `profile_exists`.
#[tokio::test]
async fn setup_09_sign_in_completes_with_the_flows_pkce() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeServer::oauth_token().await?;
    let (s, port) = with_callback_port("SETUP-09", &token).await?;

    let flow = start(&s.gw, json!({})).await?;
    let flow_id = flow["flow_id"].as_str().unwrap().to_owned();
    let challenge = auth_param(&flow, "code_challenge");
    let state = auth_param(&flow, "state");
    let (status, page) = callback(port, &format!("code=e2e-code&state={state}")).await?;
    assert_eq!(status, 200, "{page}");
    let done = flow_until(&s.gw, &flow_id, "completed").await?;
    assert_eq!(done["status"], "completed", "{done}");
    assert_eq!(done["label"], OAUTH_EMAIL, "{done}");
    assert!(!listening(port), "the listener outlived the sign-in");
    // A cancel after completion reports the real outcome.
    let late =
        s.gw.post(&format!("/setup/oauth/{flow_id}/cancel"), json!({}))
            .await?;
    assert_eq!(late.data()["status"], "completed", "{}", late.text);

    let exchange = token.seen();
    assert_eq!(exchange.len(), 1, "{exchange:?}");
    let form = &exchange[0].body;
    assert_eq!(form_value(form, "grant_type"), Some("authorization_code"));
    assert_eq!(form_value(form, "code"), Some("e2e-code"));
    let verifier = form_value(form, "code_verifier").unwrap();
    assert_eq!(s256(verifier), challenge, "the verifier is not the flow's");
    let profile: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox.data.join("auth/openai-codex.json"),
    )?)?;
    assert_eq!(profile["email"], OAUTH_EMAIL, "{profile}");
    assert_eq!(profile["accountId"], OAUTH_ACCOUNT_ID, "{profile}");

    let existing = start(&s.gw, json!({})).await?;
    assert_eq!(existing["status"], "profile_exists", "{existing}");
    assert_eq!(existing["label"], OAUTH_EMAIL, "{existing}");
    let forced = start(&s.gw, json!({"force": true})).await?;
    assert_eq!(forced["status"], "pending", "{forced}");
    let forced_id = forced["flow_id"].as_str().unwrap();
    s.gw.post(&format!("/setup/oauth/{forced_id}/cancel"), json!({}))
        .await?;
    s.finish().await
}

/// SETUP-10 — Anything else that reaches the callback listener leaves the
/// sign-in pending: an idle connection does not hold up the browser, and a
/// request with another state, no state or no code is answered and ignored
/// (any local page can reach the port). Declining in the browser (this
/// flow's state with `error`) ends it as `failed`/`oauth_denied`.
#[tokio::test]
async fn setup_10_stray_callbacks_are_ignored() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeServer::oauth_token().await?;
    let (s, port) = with_callback_port("SETUP-10", &token).await?;
    let flow = start(&s.gw, json!({})).await?;
    let flow_id = flow["flow_id"].as_str().unwrap().to_owned();
    let state = auth_param(&flow, "state");

    // An idle connection that never sends a request.
    let idle = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    for stray in [
        "code=stray&state=not-this-flow".to_owned(),
        "error=access_denied&state=not-this-flow".to_owned(),
        "code=stray".to_owned(),
        format!("state={state}"),
    ] {
        let (status, _) = callback(port, &stray).await?;
        assert_eq!(status, 400, "{stray}");
    }
    assert_eq!(
        s.gw.get(&format!("/setup/oauth/{flow_id}")).await?.data()["status"],
        "pending"
    );
    assert!(token.seen().is_empty(), "a stray request exchanged a code");

    // The browser's callback completes while the idle connection is open.
    let started = Instant::now();
    let (status, page) = callback(port, &format!("code=e2e-code&state={state}")).await?;
    assert_eq!(status, 200, "{page}");
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        Duration::from_secs(5),
        "the idle connection held it up"
    );
    assert_eq!(
        flow_until(&s.gw, &flow_id, "completed").await?["status"],
        "completed"
    );
    drop(idle);

    // Declining ends a (forced) new sign-in.
    let declined = start(&s.gw, json!({"force": true})).await?;
    let declined_id = declined["flow_id"].as_str().unwrap().to_owned();
    let declined_state = auth_param(&declined, "state");
    let (status, _) =
        callback(port, &format!("error=access_denied&state={declined_state}")).await?;
    assert_eq!(status, 400);
    let failed = flow_until(&s.gw, &declined_id, "failed").await?;
    assert_eq!(failed["error"], "oauth_denied", "{failed}");
    assert!(
        !listening(port),
        "the listener outlived the declined sign-in"
    );
    s.finish().await
}

/// Dedicated Codex auth.json rotates in place, preserving its format and
/// unknown fields. Restarting the real agent reuses the rotated login.
#[tokio::test]
async fn dedicated_codex_profile_refresh_survives_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeServer::oauth_token().await?;
    let setup = Setup::new("CODEX-PERSISTENT-REFRESH")?
        .cassette("USE-02")
        .quota_polling();
    let folder = setup.sandbox.home.join(".butler-e2e-auth");
    std::fs::create_dir_all(&folder)?;
    let path = folder.join("auth.json");
    let expired = format!(
        "e30.{}.signature",
        base64url(json!({"exp":1}).to_string().as_bytes())
    );
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "auth_mode":"chatgpt", "OPENAI_API_KEY":null, "unknown":"keep",
            "last_refresh":"original",
            "tokens":{"access_token":expired, "refresh_token":"original-refresh",
                "id_token":"original-id", "account_id":OAUTH_ACCOUNT_ID,
                "unknown_token_field":"keep"}
        }))?,
    )?;
    let original: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    // An aborted forced refresh must restore the missing expiry field without
    // changing any credentials or unknown Codex fields (never print them).
    drop(super::live::profile::ExpiryProbe::begin(path.clone())?);
    let restored: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    assert!(
        restored == original,
        "aborted expiry probe changed the profile"
    );
    let probe = super::live::profile::ExpiryProbe::begin(path.clone())?;
    let mut s = setup
        .env("BUTLER_CODEX_AUTH_PROFILE", path.display().to_string())
        .env(
            "BUTLER_CODEX_OAUTH_TOKEN_URL",
            format!("{}/oauth/token", token.base_url),
        )
        .start()
        .await?;
    let reply =
        s.gw.get("/provider-quota?provider_id=openai&refresh=1")
            .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["available"], true);
    probe.verify(
        chrono::DateTime::parse_from_rfc3339(butler_e2e::e2e::fixtures::FIXTURE_TIME)?
            .timestamp_millis(),
    )?;
    let saved = std::fs::read(&path)?;
    let auth: Value = serde_json::from_slice(&saved)?;
    assert_ne!(auth["tokens"]["access_token"], expired);
    assert_eq!(auth["tokens"]["refresh_token"], "e2e-refresh-token");
    assert_ne!(auth["tokens"]["id_token"], "original-id");
    assert_eq!(auth["tokens"]["account_id"], OAUTH_ACCOUNT_ID);
    assert_eq!(auth["tokens"]["unknown_token_field"], "keep");
    assert_eq!(auth["unknown"], "keep");
    assert_eq!(auth["auth_mode"], "chatgpt");
    assert!(auth["OPENAI_API_KEY"].is_null());
    assert_ne!(auth["last_refresh"], "original");
    assert!(auth["accessToken"].is_null(), "Codex format must survive");
    let exchanges = token.seen();
    assert_eq!(exchanges.len(), 1);
    assert_eq!(
        form_value(&exchanges[0].body, "grant_type"),
        Some("refresh_token")
    );
    assert_eq!(
        form_value(&exchanges[0].body, "refresh_token"),
        Some("original-refresh")
    );
    s.restart().await?;
    let after = s.gw.get("/provider-quota?provider_id=openai").await?;
    assert_eq!(after.data()["available"], true);
    assert_eq!(std::fs::read(&path)?, saved);
    assert_eq!(
        token.seen().len(),
        1,
        "restart must reuse the rotated token"
    );
    s.finish().await
}
