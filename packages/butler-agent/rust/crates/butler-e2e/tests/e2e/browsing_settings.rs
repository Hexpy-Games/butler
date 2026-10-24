//! Browsing preferences use the public Settings API and registered account facts.
#![allow(clippy::unwrap_used, reason = "E2E assertions")]
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};

async fn register(s: &Scenario, credential: &str, model: &str) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
                "provider_id":"opencode-go", "model_id":model, "auth_type":"api_key",
                "credential_id":credential, "api_base_url":"http://127.0.0.1:9/v1"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(())
}

async fn credential(s: &Scenario, label: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/credentials",
            json!({
                "provider_id":"opencode-go", "api_key":format!("stub-{label}")
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["credential"]["id"].as_str().unwrap().into())
}

#[tokio::test]
async fn browsing_settings_roundtrip_and_account_scoped_auto() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSING-SETTINGS")?.start().await?;
    let initial = s.gw.settings().await?;
    assert_eq!(initial["browser"]["browsing_agent"], "off");
    assert_eq!(initial["browser"]["auto"]["model"], initial["model"]);
    assert_eq!(initial["browser"]["auto"]["rule"], "conversation");
    let a = credential(&s, "account-a").await?;
    let b = credential(&s, "account-b").await?;
    register(&s, &a, "glm-5.3").await?;
    register(&s, &b, "glm-5.3-flash").await?;
    register(&s, &a, "gpt-6-luna").await?;
    let reply =
        s.gw.patch(
            "/settings",
            json!({"model":"opencode-go/glm-5.3", "browser":{"browsing_agent":"auto"}}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["browser"]["auto"]["rule"], "conversation");
    assert_eq!(
        reply.data()["browser"]["auto"]["model"],
        "opencode-go/glm-5.3"
    );
    register(&s, &a, "glm-5.3-flash").await?;
    let settings = s.gw.settings().await?;
    assert_eq!(settings["browser"]["auto"]["rule"], "family_sibling");
    assert_eq!(
        settings["browser"]["auto"]["model"],
        "opencode-go/glm-5.3-flash"
    );
    for value in ["off", "opencode-go/gpt-6-luna", "auto"] {
        let reply =
            s.gw.patch("/settings", json!({"browser":{"browsing_agent":value}}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(reply.data()["browser"]["browsing_agent"], value);
        assert_eq!(s.gw.settings().await?["browser"]["browsing_agent"], value);
        assert_eq!(reply.data()["browser"]["auto"], settings["browser"]["auto"]);
    }
    for invalid in [
        json!("missing/model"),
        json!("openai/gpt-6.1-sol"),
        Value::Null,
        json!(42),
    ] {
        let reply =
            s.gw.patch("/settings", json!({"browser":{"browsing_agent":invalid}}))
                .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
    }
    let reply =
        s.gw.patch("/settings", json!({"browser":{"auto":{}}}))
            .await?;
    assert_eq!(reply.status, 400, "{}", reply.text);
    s.restart().await?;
    let restored = s.gw.settings().await?;
    assert_eq!(restored["browser"], settings["browser"]);
    s.finish().await
}
