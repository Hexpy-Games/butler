//! First-run setup (#230): the ChatGPT sign-in flow the agent owns.
//! `POST /setup/oauth/start` returns a `flow_id` and opens a localhost
//! callback listener; `POST /setup/oauth/{flow_id}/cancel` closes it and
//! drops the PKCE state, and the flow reports `cancelled`. The browser is
//! played by the test through the local fake ChatGPT authority.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::fake_chatgpt::FakeChatGptAuthority;
use butler_e2e::e2e::fake_servers::{OAUTH_EMAIL, form_value};
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use serde_json::{Value, json};

async fn with_callback_port(
    id: &str,
    authority: &butler_e2e::e2e::fake_chatgpt::FakeChatGptAuthority,
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
fn port(flow: &Value) -> u16 {
    url::Url::parse(flow["redirect_uri"].as_str().unwrap())
        .unwrap()
        .port()
        .unwrap()
}

pub(super) async fn start(gw: &Gateway, body: Value) -> Result<Value, HarnessError> {
    let reply = gw.post("/setup/oauth/start", body).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

/// The `name` query parameter of the flow's authorization URL.
pub(super) fn auth_param(flow: &Value, name: &str) -> String {
    let url = flow["auth_url"].as_str().unwrap();
    let query = url.split_once('?').unwrap().1;
    form_value(query, name).unwrap().to_owned()
}

fn listening(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

pub(super) async fn flow_until(
    gw: &Gateway,
    flow_id: &str,
    status: &str,
) -> Result<Value, HarnessError> {
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
/// free, and a new sign-in can start.
#[tokio::test]
async fn setup_08_cancel_closes_the_listener_and_drops_the_state() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeChatGptAuthority::start().await?;
    let s = with_callback_port("SETUP-08", &token).await?;
    let flow = start(&s.gw, json!({})).await?;
    let port = port(&flow);
    assert_eq!(flow["status"], "pending", "{flow}");
    let flow_id = flow["flow_id"].as_str().unwrap().to_owned();
    assert_eq!(
        flow["redirect_uri"],
        format!("http://127.0.0.1:{port}/auth/callback"),
        "{flow}"
    );
    assert_eq!(auth_param(&flow, "code_challenge_method"), "S256");
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
    // A new sign-in owns another available callback port.
    let next = start(&s.gw, json!({})).await?;
    assert_ne!(next["flow_id"], flow_id.as_str());
    assert!(listening(self::port(&next)));
    let next_id = next["flow_id"].as_str().unwrap();
    s.gw.post(&format!("/setup/oauth/{next_id}/cancel"), json!({}))
        .await?;
    s.finish().await
}

/// SETUP-09 — A sign-in completes when the browser returns with this
/// flow's state: the code is exchanged with the verifier whose S256 is the
/// flow's challenge, the sign-in is saved under the account the token
/// names, the listener closes, and a new start reports `profile_exists`.
#[tokio::test]
async fn setup_09_sign_in_completes_with_the_flows_pkce() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeChatGptAuthority::start().await?;
    let callback_port = butler_e2e::e2e::agent::free_port()?;
    let s = Setup::new("SETUP-09")?
        .fixture(Fixture::Empty)
        .without_credential()
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &token.issuer)
        .env(
            "BUTLER_CHATGPT_API_BASE_URL",
            format!("{}/v1", token.issuer),
        )
        .env("BUTLER_CHATGPT_OAUTH_PORT", callback_port.to_string())
        .start()
        .await?;
    assert_eq!(
        super::chatgpt_sign_in::account(&s).await?["status"],
        "signed_out"
    );
    for path in ["/model-catalog", "/settings"] {
        assert_eq!(s.gw.get(path).await?.status, 200);
    }
    assert!(
        !listening(callback_port),
        "reads started a callback listener"
    );
    assert!(token.seen().is_empty(), "reads contacted the authority");
    assert!(!s.sandbox.data.join("auth/chatgpt-host.json").exists());
    super::outbound_http::logging(&s, "full").await?;

    let flow = start(&s.gw, json!({})).await?;
    let port = port(&flow);
    let flow_id = flow["flow_id"].as_str().unwrap().to_owned();
    let (status, page) = token.browser(&flow).await?;
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
    assert_eq!(exchange.iter().filter(|r| r.path == "token").count(), 1);
    let authorize = &exchange
        .iter()
        .find(|r| r.path == "authorize")
        .unwrap()
        .params;
    let form = &exchange.iter().find(|r| r.path == "token").unwrap().params;
    assert_eq!(form["grant_type"], "authorization_code");
    assert_eq!(authorize["client_id"], "dynamic_agent_client");
    assert_eq!(authorize["agent_name_hint"], "Butler");
    assert_eq!(authorize["scope"], butler_models::models::chatgpt::SCOPES);
    assert_eq!(
        authorize["resource"],
        butler_models::models::chatgpt::RESOURCE
    );
    assert_eq!(authorize["code_challenge_method"], "S256");
    assert_ne!(authorize["nonce"], "");
    let host = authorize["ext_agent_host_id"]
        .strip_prefix("urn:uuid:")
        .unwrap();
    let host_id = uuid::Uuid::parse_str(host).unwrap();
    assert_eq!(host_id.get_version_num(), 4);
    assert_eq!(host_id.hyphenated().to_string(), host);
    assert_eq!(form["resource"], butler_models::models::chatgpt::RESOURCE);
    assert_eq!(
        butler_models::models::pkce_challenge(&form["code_verifier"]),
        authorize["code_challenge"]
    );
    assert_eq!(form["redirect_uri"], flow["redirect_uri"]);
    let profile: Value =
        serde_json::from_slice(&std::fs::read(s.sandbox.data.join("auth/chatgpt.json"))?)?;
    assert_eq!(profile["email"], OAUTH_EMAIL);
    assert_eq!(profile["subject"], "e2e-subject");
    assert_eq!(done["plan_enabled"], true);
    assert_eq!(form["client_id"], profile["client_id"]);
    assert_ne!(profile["client_id"], "dynamic_agent_client");
    assert!(profile.get("id_token").is_none());
    assert_eq!(
        super::chatgpt_sign_in::account(&s).await?["status"],
        "signed_in"
    );
    let metadata = std::fs::metadata(s.sandbox.data.join("auth/chatgpt.json"))?;
    assert_eq!(
        butler_platform::secure_fs::is_owner_only(&metadata),
        butler_platform::secure_fs::OWNER_ONLY.then_some(true)
    );
    let http_logs = s.gw.get("/logs?category=http.client&limit=1000").await?;
    for key in ["access_token", "refresh_token"] {
        let secret = profile[key].as_str().unwrap();
        assert!(!s.agent.logs().contains(secret));
        assert!(!http_logs.text.contains(secret));
    }

    let rows =
        super::outbound_http::http_calls(&s, &format!("{}/api/accounts/oauth/token", token.issuer))
            .await?;
    assert_eq!(rows.len(), 1);
    for row in &rows {
        assert_eq!(row["attrs"]["purpose"], "oauth");
        assert_eq!(row["attrs"]["status"], 200);
        assert!(row.get("content").is_none_or(
            |body| body.is_null() || body.as_object().is_some_and(serde_json::Map::is_empty)
        ));
        assert!(row.get("body_ref").is_none_or(Value::is_null));
    }
    let text = serde_json::to_string(&rows)?;
    for secret in [
        "code",
        "access_token",
        "refresh_token",
        "id_token",
        "oai_is",
    ] {
        assert!(!text.contains(secret), "token body reached HTTP logs");
    }

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
