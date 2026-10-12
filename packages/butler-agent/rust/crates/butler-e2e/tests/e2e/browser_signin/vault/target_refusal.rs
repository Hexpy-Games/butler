//! A sensitive-target refusal keeps safe recovery guidance through the gateway.
use super::{CANARY, CHECKOUT, Cleanup, admin, attach, call, snapshot, tab, vault_scenario};
use butler_e2e::e2e::HarnessError;
use reqwest::Method;
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn autofill_target_refusal_keeps_recovery_without_host_values() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        super::super::fill::keychain_opt_in(),
        "system keychain opt-in required"
    );
    let s = vault_scenario("AUTOFILL-TARGET-REFUSAL", None).await?;
    let admin = admin(&s);
    let mut cleanup = Cleanup::new(&admin);
    let added = admin
        .send(
            Method::POST,
            "/security/vault/profiles",
            Some(json!({"nickname":"Profile","name":"Person"})),
            &[],
        )
        .await?;
    assert_eq!(added.status, 200);
    let id = added.data()["id"].as_str().unwrap().to_owned();
    cleanup.track("profiles", &id);
    let host = attach(
        &s,
        Arc::new(|_| {
            Box::pin(async {
                json!({"status":"not_dispatched", "reason":"incompatible_target",
                "recovery":CANARY,"targets":[{"value":CANARY}],"filled":[CANARY]})
            })
        }),
    )
    .await?;
    snapshot(&admin, json!([tab("t1", "agent", CHECKOUT)])).await?;
    let result = call(
        &admin,
        "general",
        "autofill.fill",
        "t1",
        json!({"item_id":id,
        "top_origin":"https://www.fixture-shop.test","frame_origins":[],
        "targets":[{"ref":"r1","field":"birth_date"}]}),
    )
    .await?;
    assert_eq!(result["status"], "not_dispatched");
    assert_eq!(result["reason"], "incompatible_target");
    assert!(result["recovery"].as_str().unwrap().contains("Observe"));
    assert!(result.get("targets").is_none());
    assert!(!result.to_string().contains(CANARY));
    drop(host);
    drop(cleanup);
    s.finish().await
}
