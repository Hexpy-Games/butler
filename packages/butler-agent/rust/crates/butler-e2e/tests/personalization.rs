//! F. Profile import (SCENARIOS.md PRO-02).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::fixtures::PROFILE_EXPORT as EXPORT;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::json;

/// Malformed, unknown-field, invalid-JSON and oversize import bodies are
/// refused with 400/413.
async fn reject_malformed_imports(s: &Scenario) -> Result<(), HarnessError> {
    for (body, status) in [
        (json!({"text": 5}).to_string(), 400),
        (
            json!({"text": EXPORT, "source": "chatgpt", "extra": true}).to_string(),
            400,
        ),
        ("{\"text\": ".to_owned(), 400),
        (json!({"text": "x".repeat(1_100_000)}).to_string(), 413),
    ] {
        let rejected =
            s.gw.send(
                reqwest::Method::POST,
                "/personalization/profile-import",
                Some(body),
            )
            .await?;
        assert_eq!(rejected.status, status, "{}", rejected.text);
    }
    Ok(())
}

/// PRO-02 — Profile import is safe and idempotent.
#[tokio::test]
async fn pro_02_profile_import_is_safe_and_idempotent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("PRO-02")?.cassette("PRO-02").start().await?;
    let canary = format!("e2e-canary-{}", uuid::Uuid::new_v4().simple());
    let stored =
        s.gw.post(
            "/model-catalog/provider-credentials",
            json!({"provider_id": "anthropic", "auth_type": "api_key", "api_key": canary}),
        )
        .await?;
    assert!(stored.status < 300, "{}", stored.text);
    let prompt = s.gw.get("/personalization/profile-import-prompt").await?;
    assert_eq!(prompt.status, 200, "{}", prompt.text);
    for secret in [
        canary.as_str(),
        s.gw.token.as_str(),
        &s.sandbox.root.display().to_string(),
    ] {
        assert!(
            !prompt.text.contains(secret),
            "prompt leaks data-dir secrets"
        );
    }
    let enabled =
        s.gw.patch("/personalization", json!({"profiling": {"mode": "basic"}}))
            .await?;
    assert_eq!(enabled.status, 200, "{}", enabled.text);

    let import = || {
        s.gw.post(
            "/personalization/profile-import",
            json!({"text": EXPORT, "source": "chatgpt"}),
        )
    };
    let first = import().await?;
    assert_eq!(first.status, 200, "{}", first.text);
    let data = first.data();
    assert_eq!(data["model_called"], true, "{data}");
    assert_eq!(data["raw_text_included"], false, "{data}");
    let entries = data["stable_entry_count"].as_u64().unwrap_or_default();
    assert!(
        entries >= 1 && data["promoted_count"].as_u64() >= Some(1),
        "nothing imported: {data}"
    );
    assert!(
        !first.text.contains("Lisbon"),
        "import echoes raw export text"
    );

    let second = import().await?;
    assert_eq!(second.status, 200, "{}", second.text);
    assert_eq!(second.data()["import_id"], data["import_id"]);
    assert_eq!(
        second.data()["promoted_count"],
        0,
        "re-import promoted again: {}",
        second.data()
    );
    assert_eq!(
        second.data()["stable_entry_count"].as_u64(),
        Some(entries),
        "re-import duplicated entries"
    );

    reject_malformed_imports(&s).await?;
    let after = import().await?;
    assert_eq!(
        after.data()["stable_entry_count"].as_u64(),
        Some(entries),
        "rejected imports changed the profile"
    );
    s.finish().await
}
