//! First-run setup (#230): API keys. `POST /setup/credentials/verify`
//! checks a key with the provider's model list and stores nothing;
//! `POST /credentials` stores it under a generated name (provider id, then
//! `-2`, `-3`, ...). The provider is a loopback stand-in reached through
//! the product's base-URL variables (`OPENAI_BASE_URL`,
//! `BUTLER_ANTHROPIC_BASE_URL`, `BUTLER_XAI_BASE_URL`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::{free_port, read_all};
use butler_e2e::e2e::fake_servers::{ANTHROPIC_MODEL, FakeServer, GOOD_KEY, QUOTA_KEY};
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use serde_json::{Value, json};

const BAD_KEY: &str = "sk-e2e-wrong-0003";
const OTHER_KEY: &str = "sk-e2e-good-0004";

async fn with_provider(id: &str, provider: &FakeServer) -> Result<Scenario, HarnessError> {
    let api = format!("{}/v1", provider.base_url);
    Setup::new(id)?
        .fixture(Fixture::Empty)
        .env("OPENAI_BASE_URL", api.clone())
        .env("BUTLER_ANTHROPIC_BASE_URL", api)
        .env(
            "BUTLER_XAI_BASE_URL",
            format!("http://127.0.0.1:{}/v1", free_port()?),
        )
        .start()
        .await
}

async fn verify(s: &Scenario, provider: &str, key: &str) -> Result<(u16, Value), HarnessError> {
    let reply =
        s.gw.post(
            "/setup/credentials/verify",
            json!({"provider_id": provider, "api_key": key}),
        )
        .await?;
    Ok((reply.status, reply.body))
}

async fn saved_credentials(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let catalog = s.gw.get("/model-catalog").await?;
    Ok(catalog.data()["provider_credentials"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

/// SETUP-06 — Verifying a key asks the provider and reports a stable code
/// per outcome (`invalid_key`, `no_access`, `network`); nothing is stored
/// and the key appears in no answer.
#[tokio::test]
async fn setup_06_verify_checks_the_key_and_stores_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider = FakeServer::provider_models().await?;
    let s = with_provider("SETUP-06", &provider).await?;

    let (status, body) = verify(&s, "openai", GOOD_KEY).await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["valid"], true, "{body}");
    assert_eq!(body["data"]["verified"], true, "{body}");
    assert_eq!(
        body["data"]["models"],
        json!(["gpt-6-sol", "gpt-6-luna"]),
        "{body}"
    );

    for (provider_id, key, status, code) in [
        ("openai", BAD_KEY, 422, "invalid_key"),
        ("openai", QUOTA_KEY, 422, "no_access"),
        ("anthropic", BAD_KEY, 422, "invalid_key"),
        ("xai", GOOD_KEY, 502, "network"),
        ("local", GOOD_KEY, 400, "unsupported_provider"),
    ] {
        let (actual, body) = verify(&s, provider_id, key).await?;
        assert_eq!(actual, status, "{provider_id} {key}: {body}");
        assert_eq!(body["error"]["code"], code, "{provider_id} {key}: {body}");
        assert!(!body.to_string().contains(key), "the key is echoed: {body}");
    }
    let (status, body) = verify(&s, "anthropic", GOOD_KEY).await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["models"], json!([ANTHROPIC_MODEL]), "{body}");
    // Surrounding whitespace is not part of a key; an inner line break is invalid.
    let (status, body) = verify(&s, "openai", &format!("  {GOOD_KEY}\n")).await?;
    assert_eq!(status, 200, "{body}");
    let (status, body) = verify(&s, "openai", "sk-e2e\ngood").await?;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (400, json!("invalid_request"))
    );
    let anthropic = provider
        .seen()
        .into_iter()
        .find(|seen| seen.headers.contains_key("x-api-key"))
        .expect("anthropic was asked with x-api-key");
    assert_eq!(anthropic.headers["anthropic-version"], "2023-06-01");

    let malformed =
        s.gw.post(
            "/setup/credentials/verify",
            json!({"provider_id": "openai"}),
        )
        .await?;
    assert_eq!(malformed.status, 400, "{}", malformed.text);
    assert_eq!(malformed.error_code(), Some("invalid_request"));

    assert_eq!(saved_credentials(&s).await?, [] as [serde_json::Value; 0]);
    assert!(
        !s.sandbox
            .data
            .join("auth/model-provider-credentials.json")
            .exists(),
        "verify stored a key"
    );
    let data = read_all(&s.sandbox.data);
    for key in [GOOD_KEY, BAD_KEY, QUOTA_KEY] {
        assert!(
            !data.contains(key),
            "a verified key reached the data folder"
        );
    }
    s.finish().await
}

/// SETUP-07 — Saving keys names them by provider (`openai`, `openai-2`);
/// the same key again reuses its credential; the saved key registers the
/// provider's model and survives a restart, masked.
#[tokio::test]
async fn setup_07_saved_keys_get_generated_names() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider = FakeServer::provider_models().await?;
    let mut s = with_provider("SETUP-07", &provider).await?;
    let save = |key: &'static str| {
        let gw = s.gw.clone();
        async move {
            gw.post(
                "/credentials",
                json!({"provider_id": "openai", "api_key": key}),
            )
            .await
        }
    };
    let first = save(GOOD_KEY).await?;
    assert_eq!(first.status, 201, "{}", first.text);
    let credential = &first.data()["credential"];
    assert_eq!(credential["label"], "openai", "{}", first.text);
    assert_eq!(first.data()["created"], true);
    assert!(!first.text.contains(GOOD_KEY), "the key is echoed");
    let id = credential["id"].as_str().unwrap().to_owned();

    let second = save(OTHER_KEY).await?;
    assert_eq!(second.status, 201, "{}", second.text);
    assert_eq!(second.data()["credential"]["label"], "openai-2");

    let again = save(GOOD_KEY).await?;
    assert_eq!(again.status, 200, "{}", again.text);
    assert_eq!(again.data()["created"], false);
    assert_eq!(again.data()["credential"]["id"], id.as_str());

    // Saving treats whitespace as checking does: the same key is reused.
    let padded =
        s.gw.post(
            "/credentials",
            json!({"provider_id": "openai", "api_key": format!(" {GOOD_KEY}\n")}),
        )
        .await?;
    assert_eq!(padded.status, 200, "{}", padded.text);
    assert_eq!(padded.data()["credential"]["id"], id.as_str());

    for (body, code) in [
        (
            json!({"provider_id": "openai", "api_key": "k", "name": "x"}),
            "invalid_request",
        ),
        (
            json!({"provider_id": "local", "api_key": "k"}),
            "unsupported_provider",
        ),
        (
            json!({"provider_id": "openai", "api_key": "sk-a\nb"}),
            "invalid_request",
        ),
    ] {
        let reply = s.gw.post("/credentials", body.clone()).await?;
        assert_eq!(reply.status, 400, "{body}: {}", reply.text);
        assert_eq!(reply.error_code(), Some(code), "{body}: {}", reply.text);
    }

    // Concurrent saves: distinct keys get distinct names, one key one credential.
    let distinct =
        futures_util::future::join_all(["sk-e2e-c1", "sk-e2e-c2", "sk-e2e-c3"].map(&save)).await;
    let mut names: Vec<String> = distinct
        .iter()
        .map(|reply| reply.as_ref().unwrap().data()["credential"]["label"].to_string())
        .collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), 3, "{names:?}");
    let same = futures_util::future::join_all(["sk-e2e-c4"; 3].map(&save)).await;
    let ids: std::collections::HashSet<String> = same
        .iter()
        .map(|reply| reply.as_ref().unwrap().data()["credential"]["id"].to_string())
        .collect();
    assert_eq!(ids.len(), 1, "{ids:?}");

    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({"provider_id": "openai", "model_id": "gpt-6-sol",
                   "auth_type": "api_key", "credential_id": id}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);

    s.restart().await?;
    let saved = saved_credentials(&s).await?;
    let labels: Vec<_> = saved.iter().map(|c| c["label"].clone()).collect();
    assert_eq!(labels.len(), 6, "{saved:?}");
    assert_eq!(
        labels[..2],
        [json!("openai"), json!("openai-2")],
        "{saved:?}"
    );
    let listed = serde_json::to_string(&saved)?;
    assert!(!listed.contains(GOOD_KEY) && !listed.contains(OTHER_KEY));
    s.finish().await
}
