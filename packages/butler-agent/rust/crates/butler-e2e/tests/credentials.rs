//! Saved API keys in the credential store (#217). The credentials file
//! keeps only each key's metadata; the key is in the store. The harness runs
//! every agent with `BUTLER_SECRET_STORE=file`, so here the store is the
//! owner-only fallback file `auth/credential-store.json` and no scenario
//! touches the machine's Keychain.
//!
//! - `GET /credentials`: keys, masked, with `storage` and the models using
//!   them, and where new keys go.
//! - `PATCH /credentials/{name}`: replaces a key (`verify` checks it first).
//! - `DELETE /credentials/{name}[?force=true]`: deletes a key.
//! - At start, keys saved as plain text before #217 move to the store.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::path::Path;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::read_all;
use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, GOOD_KEY};
use butler_e2e::e2e::fixtures;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use butler_platform::secure_fs::is_owner_only;
use serde_json::{Value, json};

const CREDENTIALS: &str = "auth/model-provider-credentials.json";
const STORE: &str = "auth/credential-store.json";
const KIMI_KEY: &str = "sk-e2e-kimi-legacy-0005";
const OPENAI_KEY: &str = "sk-e2e-openai-legacy-0006";
const LATE_KEY: &str = "sk-e2e-late-legacy-0007";

fn read_json(data: &Path, relative: &str) -> Value {
    serde_json::from_slice(&fs::read(data.join(relative)).unwrap()).unwrap()
}

fn owner_only(data: &Path, relative: &str) -> Option<bool> {
    is_owner_only(&fs::metadata(data.join(relative)).unwrap())
}

/// The key the store file holds for `account`.
fn stored(data: &Path, account: &str) -> Option<String> {
    read_json(data, STORE)["secrets"]
        .as_array()?
        .iter()
        .find(|entry| entry["service"] == "Butler" && entry["account"] == account)
        .and_then(|entry| entry["secret"].as_str().map(str::to_owned))
}

async fn listed(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/credentials").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

fn doctor(s: &Scenario) -> Result<Value, HarnessError> {
    let report = s
        .agent
        .cli(&["doctor", "--check", "credentials", "--json"])?
        .json()?;
    Ok(report["data"]["checks"][0].clone())
}

/// One turn on the default model; the authorization header the provider
/// stand-in received with it.
async fn turn_authorization(s: &Scenario, chat: &FakeServer) -> Result<String, HarnessError> {
    let before = chat.seen().len();
    let (_, turn) = s.turn("general", "Which key do you use?").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let seen = chat.seen();
    let request = seen[before..]
        .iter()
        .find(|seen| seen.path.ends_with("/chat/completions"))
        .expect("the turn asked the provider");
    Ok(request.headers["authorization"]
        .to_str()
        .unwrap()
        .to_owned())
}

/// CRED-01 — Keys saved as plain text before #217 move to the credential
/// store when the agent starts. A move that fails leaves every key in place
/// (the file only its owner's), the keys keep working, and the next start
/// moves them: each is written to the store and read back before the
/// credentials file is rewritten without it. Entries this version cannot
/// use are kept; running the move again changes nothing; `butler doctor`
/// reports keys still in plain text.
#[tokio::test]
async fn cred_01_plaintext_keys_move_to_the_store_at_start() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let chat = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new("CRED-01")?
        .fixture(Fixture::Empty)
        .env("BUTLER_KIMI_BASE_URL", format!("{}/v1", chat.base_url));
    let data = setup.sandbox.data.clone();
    fixtures::onboarding_complete(&data)?;
    fixtures::scheduler_ran_today(&data)?;
    fs::create_dir_all(data.join("auth"))?;
    let unusable = json!({"id": "codex", "provider_id": "openai", "auth_type": "codex_oauth"});
    fs::write(
        data.join(CREDENTIALS),
        serde_json::to_vec_pretty(&json!({"credentials": [
            {"id": "cred_kimi", "provider_id": "kimi", "auth_type": "api_key",
             "label": "kimi", "secret": KIMI_KEY,
             "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z"},
            {"id": "cred_openai", "provider_id": "openai", "auth_type": "api_key",
             "label": "openai", "secret": OPENAI_KEY},
            unusable
        ]}))?,
    )?;
    // A directory where the store file goes: every write to the store fails.
    fs::create_dir_all(data.join(STORE))?;
    let mut s = setup.start().await?;

    let kept = read_json(&data, CREDENTIALS);
    assert_eq!(kept["credentials"][0]["secret"], KIMI_KEY, "{kept}");
    assert_eq!(kept["credentials"][1]["secret"], OPENAI_KEY, "{kept}");
    assert_eq!(owner_only(&data, CREDENTIALS), Some(true));
    let list = listed(&s).await?;
    assert_eq!(list["store"]["legacy_plaintext"], 2, "{list}");
    assert_eq!(
        list["credentials"][0]["storage"], "legacy_plaintext",
        "{list}"
    );
    let log = read_all(&s.sandbox.logs);
    assert!(log.contains("[native-credentials] migration backend=fallback_file moved=0 failed=2"));
    assert!(!log.contains(KIMI_KEY) && !log.contains(OPENAI_KEY));
    let check = doctor(&s)?;
    assert_eq!(check["status"], "warn", "{check}");
    assert_eq!(check["evidence"]["legacyPlaintext"], 2, "{check}");

    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({"provider_id": "kimi", "model_id": "kimi-k3",
                   "auth_type": "api_key", "credential_id": "cred_kimi"}),
        )
        .await?;
    assert_eq!(registered.status, 201, "{}", registered.text);
    let settings =
        s.gw.patch(
            "/settings",
            json!({"model": "kimi/kimi-k3", "access_mode": "full_access"}),
        )
        .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    assert_eq!(
        turn_authorization(&s, &chat).await?,
        format!("Bearer {KIMI_KEY}")
    );

    fs::remove_dir(data.join(STORE))?;
    s.restart().await?;
    let moved = read_json(&data, CREDENTIALS);
    assert!(!moved.to_string().contains("secret"), "{moved}");
    for (index, masked) in [(0, "sk-...5"), (1, "sk-...6")] {
        let entry = &moved["credentials"][index];
        assert_eq!(entry["storage"], "fallback_file", "{moved}");
        assert_eq!(entry["masked_value"], masked, "{moved}");
    }
    assert_eq!(
        moved["credentials"][0]["created_at"],
        "2026-01-01T00:00:00.000Z"
    );
    assert_eq!(
        moved["credentials"][2], unusable,
        "an entry it cannot use is kept"
    );
    assert_eq!(stored(&data, "kimi/cred_kimi").as_deref(), Some(KIMI_KEY));
    assert_eq!(
        stored(&data, "openai/cred_openai").as_deref(),
        Some(OPENAI_KEY)
    );
    assert_eq!(owner_only(&data, STORE), Some(true));
    assert_eq!(owner_only(&data, CREDENTIALS), Some(true));
    let list = listed(&s).await?;
    assert_eq!(list["store"]["backend"], "fallback_file", "{list}");
    assert_eq!(list["store"]["requested"], "file", "{list}");
    assert_eq!(list["store"]["legacy_plaintext"], 0, "{list}");
    assert_eq!(list["credentials"][0]["storage"], "fallback_file", "{list}");
    assert_eq!(
        list["credentials"][0]["model_refs"],
        json!(["kimi/kimi-k3"])
    );
    assert!(!list.to_string().contains(KIMI_KEY));
    assert_eq!(doctor(&s)?["status"], "pass");
    assert_eq!(
        turn_authorization(&s, &chat).await?,
        format!("Bearer {KIMI_KEY}")
    );

    // A plain-text key written by an older version moves at the next start;
    // keys already moved stay exactly as they are.
    let mut late = read_json(&data, CREDENTIALS);
    late["credentials"].as_array_mut().unwrap().push(json!({
        "id": "cred_late", "provider_id": "openai", "auth_type": "api_key", "secret": LATE_KEY
    }));
    fs::write(data.join(CREDENTIALS), serde_json::to_vec_pretty(&late)?)?;
    assert_eq!(doctor(&s)?["evidence"]["legacyPlaintext"], 1);
    s.restart().await?;
    let again = read_json(&data, CREDENTIALS);
    assert_eq!(again["credentials"][0], moved["credentials"][0]);
    assert_eq!(
        again["credentials"][3]["storage"], "fallback_file",
        "{again}"
    );
    assert_eq!(stored(&data, "openai/cred_late").as_deref(), Some(LATE_KEY));
    let settled = fs::read(data.join(CREDENTIALS))?;
    s.restart().await?;
    assert_eq!(
        fs::read(data.join(CREDENTIALS))?,
        settled,
        "a second move changed the file"
    );
    s.finish().await
}

async fn with_provider(id: &str, provider: &FakeServer) -> Result<Scenario, HarnessError> {
    let api = format!("{}/v1", provider.base_url);
    Setup::new(id)?
        .fixture(Fixture::Empty)
        .env("OPENAI_BASE_URL", api.clone())
        .env("BUTLER_ANTHROPIC_BASE_URL", api)
        .start()
        .await
}

async fn save(s: &Scenario, provider: &str, key: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/credentials",
            json!({"provider_id": provider, "api_key": key}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    assert_eq!(reply.data()["credential"]["storage"], "fallback_file");
    Ok(reply.data()["credential"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}

/// CRED-02 — Replacing a key keeps its id and name and swaps the key in the
/// store; with `verify` the provider checks the new key first, and a key it
/// rejects changes nothing and is stored nowhere. A key is named by its id
/// or by a label only one key has.
#[tokio::test]
async fn cred_02_replace_swaps_the_stored_key() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider = FakeServer::provider_models().await?;
    let s = with_provider("CRED-02", &provider).await?;
    let data = s.sandbox.data.clone();
    let id = save(&s, "openai", GOOD_KEY).await?;
    let account = format!("openai/{id}");

    let rejected =
        s.gw.patch(
            "/credentials/openai",
            json!({"api_key": "sk-e2e-wrong-0003", "verify": true}),
        )
        .await?;
    assert_eq!(rejected.status, 422, "{}", rejected.text);
    assert_eq!(rejected.error_code(), Some("invalid_key"));
    assert_eq!(stored(&data, &account).as_deref(), Some(GOOD_KEY));
    assert!(
        !read_all(&data).contains("sk-e2e-wrong-0003"),
        "a rejected key was stored"
    );

    let replaced =
        s.gw.patch(
            "/credentials/openai",
            json!({"api_key": " sk-e2e-new-0008\n"}),
        )
        .await?;
    assert_eq!(replaced.status, 200, "{}", replaced.text);
    let credential = &replaced.data()["credential"];
    assert_eq!(credential["id"], id.as_str());
    assert_eq!(credential["label"], "openai");
    assert_eq!(credential["masked_value"], "sk-...8");
    assert!(
        !replaced.text.contains("sk-e2e-new-0008"),
        "the key is echoed"
    );
    assert_eq!(stored(&data, &account).as_deref(), Some("sk-e2e-new-0008"));
    let file = read_json(&data, CREDENTIALS);
    assert_eq!(file["credentials"][0]["masked_value"], "sk-...8");
    assert!(!file.to_string().contains("sk-e2e-new-0008"));

    let verified =
        s.gw.patch(
            &format!("/credentials/{id}"),
            json!({"api_key": GOOD_KEY, "verify": true}),
        )
        .await?;
    assert_eq!(verified.status, 200, "{}", verified.text);
    assert_eq!(stored(&data, &account).as_deref(), Some(GOOD_KEY));

    for label in ["shared", "shared"] {
        let reply =
            s.gw.post(
                "/model-catalog/provider-credentials",
                json!({"provider_id": "anthropic", "auth_type": "api_key",
                       "api_key": "sk-e2e-anthropic-0009", "label": label}),
            )
            .await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
    }
    for (path, body, status, code) in [
        (
            "/credentials/shared",
            json!({"api_key": "k"}),
            409,
            "credential_ambiguous",
        ),
        (
            "/credentials/nobody",
            json!({"api_key": "k"}),
            404,
            "credential_not_found",
        ),
        (
            "/credentials/openai",
            json!({"api_key": "a\nb"}),
            400,
            "invalid_request",
        ),
        (
            "/credentials/openai",
            json!({"api_key": "k", "name": "x"}),
            400,
            "invalid_request",
        ),
    ] {
        let reply = s.gw.patch(path, body.clone()).await?;
        assert_eq!(reply.status, status, "{path} {body}: {}", reply.text);
        assert_eq!(
            reply.error_code(),
            Some(code),
            "{path} {body}: {}",
            reply.text
        );
    }
    assert_eq!(stored(&data, &account).as_deref(), Some(GOOD_KEY));
    s.finish().await
}

/// CRED-03 — Deleting a key removes its record and its stored key. A key
/// the default model uses is refused even with `force`; a key another
/// registered model uses is refused unless `force`, which unregisters that
/// model too.
#[tokio::test]
async fn cred_03_delete_refuses_keys_in_use() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider = FakeServer::provider_models().await?;
    let s = with_provider("CRED-03", &provider).await?;
    let data = s.sandbox.data.clone();
    let default_key = save(&s, "openai", GOOD_KEY).await?;
    let other_key = save(&s, "anthropic", GOOD_KEY).await?;
    let unused_key = save(&s, "openai", "sk-e2e-unused-0010").await?;
    for (provider_id, model_id, credential) in [
        ("openai", "gpt-6-sol", &default_key),
        ("anthropic", "claude-fable-5-1", &other_key),
    ] {
        let reply =
            s.gw.post(
                "/model-catalog/registered-models",
                json!({"provider_id": provider_id, "model_id": model_id,
                       "auth_type": "api_key", "credential_id": credential}),
            )
            .await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
    }
    let settings =
        s.gw.patch("/settings", json!({"model": "openai/gpt-6-sol"}))
            .await?;
    assert_eq!(settings.status, 200, "{}", settings.text);

    for path in [
        format!("/credentials/{default_key}"),
        format!("/credentials/{default_key}?force=true"),
    ] {
        let refused = s.gw.delete(&path).await?;
        assert_eq!(refused.status, 409, "{path}: {}", refused.text);
        assert_eq!(refused.error_code(), Some("credential_in_use_by_default"));
    }
    let refused = s.gw.delete(&format!("/credentials/{other_key}")).await?;
    assert_eq!(refused.status, 409, "{}", refused.text);
    assert_eq!(refused.error_code(), Some("credential_in_use"));
    assert!(stored(&data, &format!("anthropic/{other_key}")).is_some());

    let forced =
        s.gw.delete(&format!("/credentials/{other_key}?force=true"))
            .await?;
    assert_eq!(forced.status, 200, "{}", forced.text);
    assert_eq!(
        forced.data()["removed_model_refs"],
        json!(["anthropic/claude-fable-5-1"])
    );
    assert_eq!(forced.data()["secret_removed"], true);
    assert!(stored(&data, &format!("anthropic/{other_key}")).is_none());
    let catalog = s.gw.get("/model-catalog").await?;
    let models = catalog.data()["registered_models"].to_string();
    assert!(!models.contains("claude-fable-5-1"), "{models}");

    let deleted = s.gw.delete(&format!("/credentials/{unused_key}")).await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    assert!(stored(&data, &format!("openai/{unused_key}")).is_none());
    let again = s.gw.delete(&format!("/credentials/{unused_key}")).await?;
    assert_eq!(again.status, 404, "{}", again.text);
    let bad = s.gw.delete("/credentials/openai?force=maybe").await?;
    assert_eq!(bad.status, 400, "{}", bad.text);

    let list = listed(&s).await?;
    let ids: Vec<&str> = list["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [default_key.as_str()], "{list}");
    s.finish().await
}

/// CRED-04 — `butler auth keys` lists the saved keys with their store,
/// replaces a key read from standard input, and deletes a key with `--yes`.
#[tokio::test]
async fn cred_04_cli_lists_replaces_and_deletes_keys() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let provider = FakeServer::provider_models().await?;
    let s = with_provider("CRED-04", &provider).await?;
    let data = s.sandbox.data.clone();
    let id = save(&s, "openai", GOOD_KEY).await?;

    let list = s.agent.cli(&["auth", "keys", "--json"])?.json()?;
    assert_eq!(list["command"], "butler auth keys");
    assert_eq!(
        list["data"]["credentials"][0]["storage"], "fallback_file",
        "{list}"
    );
    assert_eq!(list["data"]["store"]["backend"], "fallback_file", "{list}");
    assert!(!list.to_string().contains(GOOD_KEY));

    let replaced = s
        .agent
        .cli_async_input(
            &["auth", "keys", "replace", "openai", "--json"],
            Some("sk-e2e-cli-0011\n"),
        )
        .await?;
    assert_eq!(replaced.code, Some(0), "{replaced:?}");
    assert_eq!(
        replaced.json()?["data"]["credential"]["masked_value"],
        "sk-...1"
    );
    assert!(!replaced.stdout.contains("sk-e2e-cli-0011"));
    assert_eq!(
        stored(&data, &format!("openai/{id}")).as_deref(),
        Some("sk-e2e-cli-0011")
    );

    let unconfirmed = s
        .agent
        .cli(&["auth", "keys", "delete", "openai", "--json"])?;
    assert_eq!(unconfirmed.code, Some(2), "{unconfirmed:?}");
    let deleted = s
        .agent
        .cli(&["auth", "keys", "delete", "openai", "--yes", "--json"])?;
    assert_eq!(deleted.code, Some(0), "{deleted:?}");
    assert!(stored(&data, &format!("openai/{id}")).is_none());
    assert!(
        listed(&s).await?["credentials"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    s.finish().await
}
