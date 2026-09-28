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
use butler_e2e::e2e::fake_servers::{FakeServer, form_value};
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
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let digest = Sha256::digest(verifier.as_bytes());
    let mut out = String::new();
    for chunk in digest.chunks(3) {
        let bytes = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let value = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        for index in 0..=chunk.len() {
            out.push(char::from(
                ALPHABET[((value >> (18 - 6 * index)) & 63) as usize],
            ));
        }
    }
    out
}

/// SETUP-09 — A sign-in completes when the browser returns with this
/// flow's state: the code is exchanged with the verifier whose S256 is the
/// flow's challenge, the sign-in is saved, the listener closes, and a new
/// start reports `profile_exists`. A callback with another state fails the
/// flow without an exchange.
#[tokio::test]
async fn setup_09_sign_in_completes_with_the_flows_pkce() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeServer::oauth_token().await?;
    let (s, port) = with_callback_port("SETUP-09", &token).await?;

    let wrong = start(&s.gw, json!({})).await?;
    let wrong_id = wrong["flow_id"].as_str().unwrap().to_owned();
    let (status, _) = callback(port, "code=e2e-code&state=not-this-flow").await?;
    assert_eq!(status, 500);
    let failed = flow_until(&s.gw, &wrong_id, "failed").await?;
    assert_eq!(failed["error"], "oauth_state_mismatch", "{failed}");
    assert!(
        token.seen().is_empty(),
        "a mismatched state exchanged a code"
    );

    let flow = start(&s.gw, json!({})).await?;
    let flow_id = flow["flow_id"].as_str().unwrap().to_owned();
    let challenge = auth_param(&flow, "code_challenge");
    let state = auth_param(&flow, "state");
    let (status, page) = callback(port, &format!("code=e2e-code&state={state}")).await?;
    assert_eq!(status, 200, "{page}");
    let done = flow_until(&s.gw, &flow_id, "completed").await?;
    assert_eq!(done["status"], "completed", "{done}");
    assert!(
        done["label"]
            .as_str()
            .is_some_and(|label| !label.is_empty())
    );
    assert!(!listening(port), "the listener outlived the sign-in");

    let exchange = token.seen();
    assert_eq!(exchange.len(), 1, "{exchange:?}");
    let form = &exchange[0].body;
    assert_eq!(form_value(form, "grant_type"), Some("authorization_code"));
    assert_eq!(form_value(form, "code"), Some("e2e-code"));
    let verifier = form_value(form, "code_verifier").unwrap();
    assert_eq!(s256(verifier), challenge, "the verifier is not the flow's");
    assert!(s.sandbox.data.join("auth/openai-codex.json").is_file());

    let existing = start(&s.gw, json!({})).await?;
    assert_eq!(existing["status"], "profile_exists", "{existing}");
    let forced = start(&s.gw, json!({"force": true})).await?;
    assert_eq!(forced["status"], "pending", "{forced}");
    let forced_id = forced["flow_id"].as_str().unwrap();
    s.gw.post(&format!("/setup/oauth/{forced_id}/cancel"), json!({}))
        .await?;
    s.finish().await
}
