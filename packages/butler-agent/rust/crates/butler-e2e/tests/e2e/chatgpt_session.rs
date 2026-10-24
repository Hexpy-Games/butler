//! A signed-in ChatGPT session refreshes once and survives an agent restart.
use butler_e2e::e2e::{
    HarnessError, fake_chatgpt::FakeChatGptAuthority, fixtures, gateway::turn_state,
    provider::Script, scenario::Setup,
};
use serde_json::{Value, json};

#[tokio::test]
async fn siwc_08_token_refresh_survives_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let setup = Setup::new("SIWC-08")?
        .without_credential()
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "refreshed session reply".into(),
        })
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer);
    fixtures::stub_chatgpt_auth(&setup.sandbox.data, &authority)?;
    let path = setup.sandbox.data.join("auth/chatgpt.json");
    let mut original: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    original["expires_at"] = (chrono::Utc::now().timestamp_millis() - 1_000).into();
    butler_platform::secure_fs::replace_private(
        &path,
        |file| {
            use std::io::Write;
            file.write_all(original.to_string().as_bytes())
        },
        std::convert::identity,
    )?;
    let mut s = setup.start().await?;
    s.provider()?.chatgpt_authority(&authority.issuer);
    assert!(
        authority.seen().is_empty(),
        "startup does not refresh eagerly"
    );
    s.gw.patch(
        "/sessions/general",
        json!({"title":"Session refresh verification"}),
    )
    .await?;
    let (_, turn) = s
        .turn("general", "continue with my signed-in session")
        .await?;
    assert_eq!(turn_state(&turn), "delivered");
    let rotated: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    // Boolean assertions keep even fixture tokens out of failure output.
    let tokens_rotated = rotated["access_token"] != original["access_token"]
        && rotated["refresh_token"] != original["refresh_token"];
    assert!(tokens_rotated, "both tokens rotated");
    assert!(
        rotated["expires_at"]
            .as_i64()
            .is_some_and(|at| at > chrono::Utc::now().timestamp_millis())
    );
    assert_refresh(&authority);
    s.restart().await?;
    let (_, turn) = s
        .turn("general", "continue after restarting the agent")
        .await?;
    assert_eq!(turn_state(&turn), "delivered");
    let restarted: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    let rotated_tokens_preserved = restarted["access_token"] == rotated["access_token"]
        && restarted["refresh_token"] == rotated["refresh_token"];
    assert!(
        rotated_tokens_preserved,
        "restart preserves the rotated token pair"
    );
    assert_refresh(&authority);
    s.finish().await
}

fn assert_refresh(authority: &FakeChatGptAuthority) {
    let seen = authority.seen();
    let grants: Vec<_> = seen.iter().filter(|r| r.path == "token").collect();
    assert_eq!(grants.len(), 1);
    let grant = &grants[0].params;
    assert!(
        grant
            .get("grant_type")
            .is_some_and(|v| v == "refresh_token")
    );
    assert!(
        grant
            .get("resource")
            .is_some_and(|v| v == butler_models::models::chatgpt::RESOURCE)
    );
    assert!(!grant.contains_key("scope"));
    assert!(!seen.iter().any(|r| r.path == "authorize"));
}
