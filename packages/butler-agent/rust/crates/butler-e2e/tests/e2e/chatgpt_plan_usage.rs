//! P1 migration backend acceptance. Turn routing belongs to P2.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::chatgpt_sign_in::{account, scenario, settle, start};
use butler_e2e::e2e::{
    HarnessError,
    fake_chatgpt::{FakeChatGptAuthority, Faults},
};
use serde_json::json;

#[tokio::test]
async fn siwc_14_legacy_migration_preserves_credentials_until_success() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let s = scenario("SIWC-14", &authority).await?;
    let path = s.sandbox.data.join("auth/openai-codex.json");
    std::fs::create_dir_all(path.parent().unwrap())?;
    let original = b"{\"accessToken\":\"legacy-secret\"}";
    std::fs::write(&path, original)?;
    let view = account(&s).await?;
    assert_eq!(view["status"], "legacy_sign_in_required");
    assert_eq!(view["legacy_prompt_pending"], true);
    assert!(!s.sandbox.data.join("auth/chatgpt-host.json").exists());
    let ack =
        s.gw.post("/setup/chatgpt-account/notice", json!({"kind":"legacy"}))
            .await?;
    assert_eq!(ack.status, 200);
    assert_eq!(account(&s).await?["legacy_prompt_pending"], false);
    let flow = start(&s, json!({})).await?;
    s.gw.post(
        &format!("/setup/oauth/{}/cancel", flow["flow_id"].as_str().unwrap()),
        json!({}),
    )
    .await?;
    assert_eq!(std::fs::read(&path)?, original);
    authority.faults(Faults {
        deny: true,
        ..Default::default()
    });
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["error"], "oauth_denied");
    assert_eq!(std::fs::read(&path)?, original);
    authority.faults(Faults::default());
    let flow = start(&s, json!({})).await?;
    authority.browser(&flow).await?;
    assert_eq!(settle(&s, &flow).await?["status"], "completed");
    assert!(!path.exists());
    assert_eq!(account(&s).await?["plan_notice_pending"], true);
    let ack =
        s.gw.post("/setup/chatgpt-account/notice", json!({"kind":"plan"}))
            .await?;
    assert_eq!(ack.status, 200);
    assert_eq!(account(&s).await?["plan_notice_pending"], false);
    s.finish().await
}

mod limit;

pub(super) mod windows;

mod search;
