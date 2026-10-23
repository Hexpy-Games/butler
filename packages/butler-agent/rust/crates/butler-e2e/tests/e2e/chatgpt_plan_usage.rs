//! ChatGPT-plan user flows through public agent routes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::chatgpt_sign_in::{account, settle, start};
use butler_e2e::e2e::{HarnessError, fake_chatgpt::FakeChatGptAuthority};
use serde_json::json;

#[tokio::test]
async fn siwc_14_legacy_migration_preserves_credentials_until_success() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let setup = butler_e2e::e2e::scenario::Setup::new("SIWC-14")?
        .without_credential()
        .synthetic(butler_e2e::e2e::provider::Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "migration-ok".into(),
        })
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer);
    let path = setup.sandbox.data.join("auth/openai-codex.json");
    std::fs::create_dir_all(path.parent().unwrap())?;
    let original = b"{\"accessToken\":\"legacy-secret\"}";
    std::fs::write(&path, original)?;
    let s = setup.start().await?;
    let view = account(&s).await?;
    assert_eq!(view["status"], "legacy_sign_in_required");
    assert_eq!(view["legacy_prompt_pending"], true);
    assert!(!s.sandbox.data.join("auth/chatgpt-host.json").exists());
    let ack =
        s.gw.post("/setup/chatgpt-account/notice", json!({"kind":"legacy"}))
            .await?;
    assert_eq!(ack.status, 200);
    assert_eq!(account(&s).await?["legacy_prompt_pending"], false);
    let (_, turn) = s.turn("general", "continue after migration notice").await?;
    assert_eq!(butler_e2e::e2e::gateway::turn_state(&turn), "failed");
    assert!(turn.to_string().contains("chatgpt_sign_in_required"));
    assert_eq!(s.provider()?.requests(), [] as [serde_json::Value; 0]);
    assert!(authority.seen().is_empty());
    assert_eq!(std::fs::read(&path)?, original);
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
