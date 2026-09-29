//! Which store saved API keys go to (#217): the owner-only file in the data
//! folder, unless the build is Developer ID signed or the configuration
//! asks for the system store (`secrets.store = "system"`). The harness's
//! `BUTLER_SECRET_STORE=file` wins for a data folder other than the user's
//! own; the scenario here clears it to see the product's own choice. No
//! scenario uses the system store.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_platform::secure_fs::{OWNER_ONLY, is_owner_only};
use serde_json::Value;

const KEY: &str = "sk-e2e-cred05-0013";

/// CRED-05 — An unsigned build keeps new keys in the owner-only file
/// (reason `unsigned_build`), with a fingerprint and no key in the
/// credentials file; `secrets.store = "file"` is reported as configured and
/// an unknown store is refused; `GET /credentials` and `butler doctor`
/// report the store and why.
#[tokio::test]
async fn cred_05_unsigned_builds_keep_keys_in_the_file() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CRED-05")?
        .fixture(Fixture::Empty)
        .env("BUTLER_SECRET_STORE", "")
        .start()
        .await?;
    let data = s.sandbox.data.clone();
    let store = |s: &Value| s["data"]["store"].clone();

    let listed = s.gw.get("/credentials").await?;
    assert_eq!(listed.status, 200, "{}", listed.text);
    assert_eq!(
        store(&listed.body)["backend"],
        "fallback_file",
        "{}",
        listed.text
    );
    assert_eq!(
        store(&listed.body)["reason"],
        "unsigned_build",
        "{}",
        listed.text
    );
    assert_eq!(store(&listed.body)["override_ignored"], false);
    let doctor = s
        .agent
        .cli(&["doctor", "--check", "credentials", "--json"])?
        .json()?;
    let check = &doctor["data"]["checks"][0];
    assert_eq!(check["status"], "pass", "{check}");
    assert_eq!(check["evidence"]["store"], "file", "{check}");
    assert_eq!(check["evidence"]["reason"], "unsigned_build", "{check}");

    let saved =
        s.gw.post(
            "/credentials",
            serde_json::json!({"provider_id": "openai", "api_key": KEY}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    assert_eq!(saved.data()["credential"]["storage"], "fallback_file");
    let file: Value = serde_json::from_slice(&fs::read(
        data.join("auth/model-provider-credentials.json"),
    )?)?;
    let entry = &file["credentials"][0];
    assert!(!file.to_string().contains(KEY), "{file}");
    let fingerprint = entry["fingerprint"].as_str().unwrap_or_default();
    assert_eq!(fingerprint.len(), 64, "{entry}");
    let store_file = data.join("auth/credential-store.json");
    assert!(fs::read_to_string(&store_file)?.contains(KEY));
    assert_eq!(
        is_owner_only(&fs::metadata(&store_file)?),
        OWNER_ONLY.then_some(true)
    );

    let set = s
        .agent
        .cli(&["config", "set", "secrets.store", "file", "--json"])?;
    assert_eq!(set.code, Some(0), "{set:?}");
    let got = s.agent.cli(&["config", "get", "secrets.store", "--json"])?;
    assert!(got.stdout.contains("\"file\""), "{got:?}");
    let listed = s.gw.get("/credentials").await?;
    assert_eq!(store(&listed.body)["reason"], "config", "{}", listed.text);
    assert_eq!(store(&listed.body)["backend"], "fallback_file");
    let refused = s
        .agent
        .cli(&["config", "set", "secrets.store", "vault", "--json"])?;
    assert_ne!(refused.code, Some(0), "{refused:?}");
    s.finish().await
}
