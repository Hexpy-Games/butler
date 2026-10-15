//! Payment vault and autofill profiles: Settings keeps only masked metadata
//! (numbers live in the OS credential store), a fill token is single use and
//! bound to the exact top-level and payment frame origins, purchase sites let
//! a merchant skip the final card, and a canary card number never appears in
//! results, events, logs or the data folder. The keychain checks are opt-in
//! like the sign-in fill (`BUTLER_PLATFORM_SYSTEM_SECRETS=1`).
mod fill;
mod migration;
mod profile_tool;
mod target_refusal;
mod tool;

use super::host::{admin, attach, call, snapshot};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) const CHECKOUT: &str = "https://www.fixture-shop.test/checkout";
pub(super) const CARD: &str = "4000 0566 5566 5556";
pub(super) const CANARY: &str = "4000056655665556";

/// A signed-out conversation tab (the vault works on any conversation tab).
pub(super) fn tab(id: &str, holder: &str, url: &str) -> Value {
    json!({"id": id, "owner": "conversation:general", "epoch": 1, "holder": holder, "url": url})
}

/// A scenario on the system keychain that never shows an OS prompt (reveal is denied).
pub(super) async fn vault_scenario(
    id: &str,
    cassette: Option<butler_e2e::e2e::cassette::Cassette>,
) -> Result<Scenario, HarnessError> {
    let mut setup = Setup::new(id)?
        .env("BUTLER_SECRET_STORE", "")
        .env("BUTLER_USER_AUTH", "deny")
        .data_folder_token();
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    if let Some(cassette) = cassette {
        setup = setup.stub_cassette(cassette);
    }
    let s = setup.start().await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| json!({}));
    config["secrets"] = json!({"store": "system"});
    std::fs::write(&path, serde_json::to_vec_pretty(&config)?)?;
    Ok(s)
}

/// Deletes every vault item this scenario added (and its keychain item), also on failure.
pub(super) struct Cleanup {
    admin: butler_e2e::e2e::security::AdminClient,
    paths: Vec<String>,
}

impl Cleanup {
    pub(super) fn new(admin: &butler_e2e::e2e::security::AdminClient) -> Self {
        Self {
            admin: admin.clone(),
            paths: Vec::new(),
        }
    }
    pub(super) fn track(&mut self, kind: &str, id: &str) {
        self.paths.push(format!("/security/vault/{kind}/{id}"));
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let (admin, paths) = (self.admin.clone(), std::mem::take(&mut self.paths));
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                for path in paths {
                    let _ = admin.send(Method::DELETE, &path, None, &[]).await;
                }
            });
        })
        .join();
    }
}

#[tokio::test]
async fn vault_is_off_on_the_file_store_and_purchase_sites_skip_the_final_card()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-VAULT-OFF")?.start().await?;
    let admin = admin(&s);
    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(view.data()["available"], false);
    let card = json!({"number": CARD, "exp_month": 12, "exp_year": 2030});
    let added = admin
        .send(Method::POST, "/security/vault/cards", Some(card), &[])
        .await?;
    assert_eq!(
        added.status, 409,
        "the file store keeps no card: {}",
        added.text
    );
    assert!(!added.text.contains(CANARY));

    let host = attach(&s, Arc::new(|frame: Value| Box::pin(async move {
        json!({"status":"ok","tab":frame["tab"],"url":CHECKOUT,"obs":"o1",
            "steps":[{"action":"click","payment":true,"submit":true,"hit":{"role":"button","name":"결제","frame":"www.fixture-shop.test"}}]})
    }))).await?;
    snapshot(&admin, json!([tab("t1", "agent", CHECKOUT)])).await?;
    let looked = call(&admin, "general", "pay.lookup", "t1", json!({})).await?;
    assert_eq!(looked["reason"], "vault_unavailable", "{looked}");
    let prepare = json!({"observation":"o1","steps":[{"action":"click","ref":"e1"}]});
    let before = call(&admin, "general", "tab.prepare", "t1", prepare.clone()).await?;
    assert_eq!(before["purchase_allowed"], false, "default off: {before}");
    // A standing purchase site needs no secret store; a URL names its site.
    let allow = json!({"site": "https://www.fixture-shop.test/cart", "allow": true});
    let set = admin
        .send(
            Method::POST,
            "/security/vault/purchase-sites",
            Some(allow),
            &[],
        )
        .await?;
    assert_eq!(set.status, 200, "{}", set.text);
    let view = admin
        .send(Method::GET, "/security/vault", None, &[])
        .await?;
    assert_eq!(view.data()["purchase_sites"], json!(["fixture-shop.test"]));
    let allowed = call(&admin, "general", "tab.prepare", "t1", prepare.clone()).await?;
    assert_eq!(allowed["purchase_allowed"], true, "{allowed}");
    let off = json!({"site": "fixture-shop.test", "allow": false});
    admin
        .send(
            Method::POST,
            "/security/vault/purchase-sites",
            Some(off),
            &[],
        )
        .await?;
    let after = call(&admin, "general", "tab.prepare", "t1", prepare).await?;
    assert_eq!(after["purchase_allowed"], false, "{after}");
    assert!(host.ops().contains(&"tab.prepare".to_owned()));
    s.finish().await
}
