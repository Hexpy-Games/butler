use super::{fill, host::admin};
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer},
    fixtures,
    gateway::turn_state,
    scenario::{Fixture, Scenario, Setup},
};
use butler_platform::secrets::{
    SecretKey, isolated_system_secret_present_for_test, make_system_keychain_unavailable_for_test,
};
use reqwest::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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

#[tokio::test]
async fn keychain_secrets_move_into_the_vault_when_turned_on_and_open_with_one_keychain_read()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        fill::keychain_opt_in(),
        "system keychain check needs BUTLER_PLATFORM_SYSTEM_SECRETS=1"
    );
    let chat = FakeServer::local_models(ChatBehavior::default()).await?;
    let setup = Setup::new("VAULT-SWITCH")?
        .fixture(Fixture::Empty)
        .env("BUTLER_SECRET_STORE", "")
        .env("BUTLER_KIMI_BASE_URL", format!("{}/v1", chat.base_url));
    let data = setup.sandbox.data.clone();
    fill::link_keychains(&setup.sandbox.home)?;
    fixtures::onboarding_complete(&data)?;
    fixtures::scheduler_ran_today(&data, fixtures::FIXTURE_TIME)?;
    std::fs::create_dir_all(data.join("auth"))?;
    std::fs::write(
        data.join("auth/model-provider-credentials.json"),
        serde_json::to_vec_pretty(&json!({"credentials": [{
            "id": "cred_kimi", "provider_id": "kimi", "auth_type": "api_key",
            "label": "kimi", "secret": "sk-e2e-vault-kimi-0001",
            "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z"
        }]}))?,
    )?;
    let mut s = setup.start().await?;
    let config_path = data.join("butler.config.json");
    let mut config: Value = std::fs::read(&config_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    config["secrets"] = json!({"store": "system"});
    std::fs::write(&config_path, serde_json::to_vec_pretty(&config)?)?;
    let client = admin(&s);
    let added = client
        .send(
            Method::POST,
            "/security/signins",
            Some(json!({
                "origin": "https://login.fixture-shop.test", "username": "owner@fixture.test",
                "password": fill::CANARY
            })),
            &[],
        )
        .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let entry = added.data()["id"].as_str().unwrap().to_owned();
    let mut cleanup = fill::Cleanup::new(&client);
    cleanup.track(&entry);
    s.restart().await?;
    assert!(!data.join("auth/vault.age").exists());
    let view = s.gw.get("/setup/butler-vault").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(view.data()["state"], "off");
    assert_eq!(view.data()["available"], true);
    assert_eq!(view.data()["declined"], false);
    let declined = s.gw.post("/setup/butler-vault/decline", json!({})).await?;
    assert_eq!(declined.status, 200, "{}", declined.text);
    assert_eq!(declined.data()["declined"], true);
    assert_eq!(declined.data()["state"], "off");
    s.restart().await?;
    assert!(!data.join("auth/vault.age").exists());
    let enabled = s.gw.post("/setup/butler-vault/enable", json!({})).await?;
    assert_eq!(enabled.status, 200, "{}", enabled.text);
    assert_eq!(enabled.data()["state"], "protected");
    assert_eq!(enabled.data()["declined"], false);
    assert_eq!(enabled.data()["counts"]["api_key"], 1);
    assert_eq!(enabled.data()["counts"]["signin"], 1);
    assert!(data.join("auth/vault.age").is_file());
    let marker_path = data.join("auth/vault-migration.json");
    assert!(marker_path.is_file());
    let marker = std::fs::read(&marker_path)?;
    assert_eq!(serde_json::from_slice::<Value>(&marker)?["items"], 2);
    // The product hashes the std spelling (Windows keeps the \\?\ prefix).
    let root = std::fs::canonicalize(&data)?;
    let hash = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    for (service, account) in [
        (
            format!("com.hexpy.butler.signin.{}", &hash[..12]),
            entry.as_str(),
        ),
        (
            format!("com.hexpy.butler.model-credential.{}", &hash[..16]),
            "kimi/cred_kimi",
        ),
    ] {
        assert!(isolated_system_secret_present_for_test(
            &s.sandbox.home,
            &SecretKey::new(&service, account).unwrap()
        )?);
    }
    let enabled = s.gw.post("/setup/butler-vault/enable", json!({})).await?;
    assert_eq!(enabled.status, 200, "{}", enabled.text);
    assert_eq!(enabled.data()["state"], "protected");
    assert_eq!(std::fs::read(&marker_path)?, marker);
    s.restart().await?;
    make_system_keychain_unavailable_for_test(&s.sandbox.home)?;
    assert_eq!(
        turn_authorization(&s, &chat).await?,
        "Bearer sk-e2e-vault-kimi-0001"
    );
    let offered = admin(&s)
        .send(
            Method::POST,
            "/security/signins/offer",
            Some(json!({
                "origin": "https://login.fixture-shop.test", "username": "owner@fixture.test",
                "password": fill::CANARY
            })),
            &[],
        )
        .await?;
    assert_eq!(offered.status, 200, "{}", offered.text);
    assert_eq!(offered.data()["offer"], false);
    let credentials = s.gw.get("/credentials").await?;
    assert_eq!(credentials.status, 200, "{}", credentials.text);
    let credentials = credentials.data();
    let kimi = credentials["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|credential| credential["id"] == "cred_kimi")
        .unwrap();
    assert_eq!(kimi["storage"], "vault");
    assert_eq!(credentials["store"]["backend"], "vault");
    drop(cleanup);
    s.finish().await
}
