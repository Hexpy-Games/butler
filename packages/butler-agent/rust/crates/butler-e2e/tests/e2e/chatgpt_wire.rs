//! Request constraints and recovery at the agent's real model route.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, provider::Script, scenario::Setup};
use serde_json::{Value, json};
#[tokio::test]
async fn siwc_15_discovery_visibility_registration_and_offline_cache() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SIWC-15")?
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "catalog-ok".into(),
        })
        .start()
        .await?;
    let authority = s.authority.as_ref().unwrap();
    authority.models(vec![
        json!({"slug":"gpt-6-luna","display_name":"Luna","visibility":"list"}),
        json!({"slug":"gpt-6-astra","display_name":"Astra","visibility":"list"}),
        json!({"slug":"gpt-6-sol","display_name":"Sol","visibility":"hide"}),
        json!({"slug":"unlisted-catalog-model","display_name":"Unknown","visibility":"list"}),
    ]);
    let config_path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["system"]
        .as_object_mut()
        .unwrap()
        .remove("defaultModel");
    config["models"] = json!({"registered":[
        {"provider_id":"openai","model_id":"gpt-6-luna","auth_type":"chatgpt_oauth"},
        {"provider_id":"openai","model_id":"gpt-6-astra","auth_type":"chatgpt_oauth"},
        {"provider_id":"openai","model_id":"gpt-6-sol","auth_type":"chatgpt_oauth"}
    ]});
    std::fs::write(&config_path, serde_json::to_vec(&config)?)?;
    let catalog = s.gw.get("/model-catalog").await?;
    assert_eq!(catalog.status, 200);
    let provider = catalog.data()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["provider_id"] == "openai")
        .unwrap();
    assert_eq!(
        provider["chatgpt_plan_models"],
        json!(["gpt-6-luna", "gpt-6-astra"])
    );
    let registered = catalog.data()["registered_models"].as_array().unwrap();
    assert_eq!(registered.len(), 3);
    for model in registered {
        assert_eq!(model["auth_type"], "chatgpt_oauth");
        assert_eq!(
            model["availability"],
            if model["model_id"] == "gpt-6-sol" {
                "not_in_plan"
            } else {
                "ready"
            }
        );
    }
    s.finish().await
}
