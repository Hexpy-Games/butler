//! A full reset deletes every hook secret it wrote, whatever hooks.json says now.
use super::*;
use butler_platform::secrets::{SYSTEM_BACKEND, isolated_system_secret_present_for_test};
use std::fs;

#[tokio::test]
async fn hook_secrets_are_deleted_even_when_hooks_json_is_unusable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("RESET-HOOK-SECRETS")?.env("BUTLER_SECRET_STORE", "system");
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    let mut s = setup.start().await?;
    let root = s.sandbox.data.clone();
    // The harness writes the configuration at startup; the policy is read per call.
    let config_path = root.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&config_path)?).unwrap();
    config["secrets"] = json!({"store":"system"});
    fs::write(&config_path, config.to_string())?;
    let key = |id: &str| {
        butler_models::models::scoped_secret_key(
            &root,
            SYSTEM_BACKEND,
            "com.hexpy.butler.hook-secret",
            id,
        )
        .unwrap()
    };
    let hook = |id: &str| json!({"id":id,"event":"Stop","type":"http","url":"https://hooks.example.com/hook"});
    let current = admin(&s).send(Method::GET, "/hooks", None, &[]).await?;
    let body = json!({
        "revision": current.data()["revision"],
        "config": {"version":1,"hooks":[hook("removed-by-hand"), hook("still-listed")]},
    });
    let saved = admin(&s)
        .send(Method::PUT, "/hooks", Some(body), &[])
        .await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    for id in ["removed-by-hand", "still-listed"] {
        assert!(
            isolated_system_secret_present_for_test(&s.sandbox.home, &key(id))?,
            "{id} is in the system store"
        );
    }

    // One hook removed by hand, then the whole file made unreadable.
    let file = root.join("hooks.json");
    fs::write(
        &file,
        json!({"version":1,"hooks":[hook("still-listed")]}).to_string(),
    )?;
    admin(&s).send(Method::GET, "/hooks", None, &[]).await?;
    fs::write(&file, b"not json")?;

    assert_eq!(request(&s, &nonce(&s).await?).await?.status, 202);
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    cleaned(&root).await;
    for id in ["removed-by-hand", "still-listed"] {
        assert!(
            !isolated_system_secret_present_for_test(&s.sandbox.home, &key(id))?,
            "{id} survived the reset"
        );
    }
    s.finish().await
}
