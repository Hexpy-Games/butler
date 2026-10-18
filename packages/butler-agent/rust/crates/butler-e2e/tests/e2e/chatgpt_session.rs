//! Official registration refresh through real agent turns, entirely local.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    events::LiveEvents,
    fake_chatgpt::Faults,
    gateway::turn_state,
    provider::Script,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{fs, time::Duration};
fn script() -> Script {
    Script {
        rounds: 0,
        path_for: Box::new(|_| String::new()),
        final_text: "session-ok".into(),
    }
}
pub(super) async fn scenario(id: &str) -> Result<Scenario, HarnessError> {
    Setup::new(id)?.synthetic(script()).start().await
}
pub(super) fn read(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(serde_json::from_slice(&fs::read(
        s.sandbox.data.join("auth/chatgpt.json"),
    )?)?)
}
pub(super) fn write(s: &Scenario, value: &Value) -> Result<(), HarnessError> {
    fs::write(
        s.sandbox.data.join("auth/chatgpt.json"),
        serde_json::to_vec(value)?,
    )?;
    Ok(())
}
fn refreshes(s: &Scenario) -> usize {
    s.authority
        .as_ref()
        .unwrap()
        .seen()
        .iter()
        .filter(|r| {
            r.path == "token"
                && r.params
                    .get("grant_type")
                    .is_some_and(|v| v == "refresh_token")
        })
        .count()
}
#[tokio::test]
async fn siwc_08_rotation_lock_and_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = scenario("SIWC-08").await?;
    let mut original = read(&s)?;
    original["expires_at"] = (chrono::Utc::now().timestamp_millis() + 60_000).into();
    original["earliest_refresh_at"] = i64::MAX.into();
    write(&s, &original)?;
    assert_eq!(
        turn_state(&s.turn("general", "earliest refresh lower bound").await?.1),
        "delivered"
    );
    assert_eq!(refreshes(&s), 0);
    assert!(read(&s)? == original, "registration changed unexpectedly");
    original["expires_at"] = 1.into();
    original["unknown"] = "preserved".into();
    write(&s, &original)?;
    let dir = s.sandbox.data.join("auth");
    let second = Setup::new("SIWC-08-CONCURRENT")?
        .synthetic(script())
        .env("BUTLER_CHATGPT_AUTH_DIR", dir.display().to_string())
        .start()
        .await?;
    let (left, right) = tokio::join!(
        s.turn("general", "session concurrent one"),
        second.turn("general", "session concurrent two")
    );
    assert_eq!(turn_state(&left?.1), "delivered");
    assert_eq!(turn_state(&right?.1), "delivered");
    assert_eq!(refreshes(&s), 1);
    let saved = read(&s)?;
    assert!(
        saved["access_token"] != original["access_token"],
        "rotation did not replace access_token"
    );
    assert!(
        saved["refresh_token"] != original["refresh_token"],
        "rotation did not replace refresh_token"
    );
    assert!(saved["expires_at"].as_i64().unwrap() > chrono::Utc::now().timestamp_millis());
    assert_eq!(saved["unknown"], "preserved");
    let seen = s.authority.as_ref().unwrap().seen();
    let form = &seen.iter().find(|r| r.path == "token").unwrap().params;
    assert_eq!(form["resource"], butler_models::models::chatgpt::RESOURCE);
    assert!(!form.contains_key("scope"));
    second.finish().await?;
    s.restart().await?;
    assert_eq!(
        turn_state(&s.turn("general", "session after restart").await?.1),
        "delivered"
    );
    assert!(read(&s)? == saved, "restart changed the registration");
    assert_eq!(refreshes(&s), 1);
    s.finish().await
}
#[tokio::test]
async fn siwc_09_terminal_and_transient_refreshes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for terminal in [false, true] {
        let s = scenario(if terminal {
            "SIWC-09-REUSED"
        } else {
            "SIWC-09-TRANSIENT"
        })
        .await?;
        let authority = s.authority.as_ref().unwrap();
        authority.faults(Faults {
            refresh_503: !terminal,
            refresh_reused: terminal,
            ..Default::default()
        });
        let mut original = read(&s)?;
        original["expires_at"] = if terminal {
            1
        } else {
            chrono::Utc::now().timestamp_millis() + 60_000
        }
        .into();
        write(&s, &original)?;
        let events = LiveEvents::subscribe(&s.gw, 0).await?;
        let (_, turn) = s.turn("general", "refresh error state").await?;
        if terminal {
            assert_eq!(turn_state(&turn), "failed");
            assert!(turn.to_string().contains("chatgpt_sign_in_required"));
            let saved = read(&s)?;
            assert!(saved["access_token"].is_null() && saved["refresh_token"].is_null());
            assert_eq!(saved["client_id"], original["client_id"]);
            assert_eq!(saved["sign_in_required"], "refresh_rejected");
            assert_eq!(s.provider()?.requests(), [] as [Value; 0]);
            events
                .wait_for(Duration::from_secs(5), |e| {
                    e["type"] == "setup.chatgpt_account_changed"
                })
                .await?;
        } else {
            assert_eq!(turn_state(&turn), "delivered");
            assert!(read(&s)? == original, "registration changed unexpectedly");
            original["expires_at"] = 1.into();
            write(&s, &original)?;
            let requests = s.provider()?.requests().len();
            let (_, expired) = s.turn("general", "expired refresh unavailable").await?;
            assert_eq!(turn_state(&expired), "failed");
            assert!(
                expired
                    .to_string()
                    .contains("provider_auth_refresh_unavailable")
            );
            assert_eq!(s.provider()?.requests().len(), requests);
            assert!(
                read(&s)? == original,
                "transient failure changed the registration"
            );
        }
        s.finish().await?;
    }
    let s = scenario("SIWC-09-CLIENT").await?;
    let authority = s.authority.as_ref().unwrap();
    authority.faults(Faults {
        invalid_client: true,
        ..Default::default()
    });
    let mut raw = read(&s)?;
    raw["expires_at"] = 1.into();
    write(&s, &raw)?;
    let (_, turn) = s.turn("general", "invalid client state").await?;
    assert_eq!(turn_state(&turn), "failed");
    assert!(read(&s)?["client_id"].is_null());
    let flow = super::chatgpt_sign_in::start(&s, json!({})).await?;
    let url = url::Url::parse(flow["auth_url"].as_str().unwrap()).unwrap();
    assert!(
        url.query_pairs()
            .any(|(k, v)| k == "client_id" && v == "dynamic_agent_client")
    );
    s.finish().await
}
#[tokio::test]
async fn siwc_05_and_14_turns_fail_without_network() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for legacy in [false, true] {
        let s = scenario(if legacy {
            "SIWC-14-TURN"
        } else {
            "SIWC-05-TURN"
        })
        .await?;
        let mut raw = read(&s)?;
        if legacy {
            fs::remove_file(s.sandbox.data.join("auth/chatgpt.json"))?;
            fs::write(s.sandbox.data.join("auth/openai-codex.json"), b"legacy")?;
        } else {
            raw["scopes"] = json!(["openid"]);
            write(&s, &raw)?;
        }
        let before = s.authority.as_ref().unwrap().seen().len();
        let (_, turn) = s.turn("general", "local permission failure").await?;
        assert_eq!(turn_state(&turn), "failed");
        assert!(turn.to_string().contains(if legacy {
            "chatgpt_sign_in_required"
        } else {
            "chatgpt_plan_not_enabled"
        }));
        assert_eq!(s.provider()?.requests(), [] as [Value; 0]);
        assert_eq!(s.authority.as_ref().unwrap().seen().len(), before);
        s.finish().await?;
    }
    Ok(())
}
