//! Delegated policy cannot use the user's question-settlement authority.
use super::*;
use butler_core::locale::LocaleCollation;
use butler_turn::btcc::{
    BtccRepositories, BtccStorage, PrincipalAuthority, ResolveAsk, TestStorageFixture, TurnStore,
    test_prepared_turn,
};
use std::sync::Arc;

#[tokio::test]
async fn delegated_roles_hide_reminders_and_refuse_direct_settlement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, provider, server) = setup("RM-DELEGATED").await?;
    let q = named_ask(&s, &provider, "Format").await?;
    let (url, script, child_server) = crate::steward_presentation::stub::start().await?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(s.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = s.sandbox.data.display().to_string();
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    s.gw = s.agent.start_again().await?;
    server.abort();
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    s.turn("general", crate::steward_presentation::stub::OWNER)
        .await?;
    // Reuse PA-03's real delegated approval lane. Resuming its card rebuilds
    // the host prompt with an open question already present for the child.
    live.wait_for(Duration::from_secs(20), |event| {
        event["type"] == "pending_asks.changed"
            && event["payload"]["kind"] == "approval"
            && event["payload"]["state"] == "open"
    })
    .await?;
    let page = asks(&s, "general").await?;
    let approval = page["asks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|ask| ask["kind"] == "approval")
        .unwrap();
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child_id = view.data()["steward_children"][0]["session_id"]
        .as_str()
        .unwrap();
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.execute(
            "UPDATE btcc_authority_requests SET owner_session_id=?1 WHERE request_ref=?2",
            rusqlite::params![
                child_id,
                q["ask_id"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("question:")
                    .unwrap()
            ],
        )?,
        1
    );
    drop(db);
    let before = script.requests.lock().unwrap().len();
    let reference = approval["ask_id"]
        .as_str()
        .unwrap()
        .strip_prefix("approval:")
        .unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{}", allowed.text);
    let resumed = resumed_child_request(&script, before).await?;
    assert!(!source(&resumed).contains("## Open asks"));
    assert!(
        butler_e2e::e2e::chatgpt_wire::functions(&resumed)
            .all(|tool| tool["name"] != "resolve_ask")
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let open: usize = db.query_row(
        "SELECT COUNT(*) FROM btcc_authority_requests WHERE owner_session_id=?1 AND capability='ask_user' AND outcome_receipt_json IS NULL AND close_reason IS NULL",
        [child_id], |row| row.get(0),
    )?;
    assert_eq!(open, 1);
    drop(db);
    child_server.abort();
    s.finish().await?;
    direct_refusals(q["ask_id"].as_str().unwrap()).await
}

async fn resumed_child_request(
    script: &crate::steward_presentation::stub::Script,
    before: usize,
) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let request = script
                .requests
                .lock()
                .unwrap()
                .iter()
                .skip(before)
                .find(|request| crate::steward_presentation::stub::child_lane(request))
                .cloned();
            if let Some(request) = request {
                return request;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))
}

async fn direct_refusals(ask_id: &str) -> Result<(), HarnessError> {
    // Use the same persisted-turn helper as usage_delegated::inheritance to
    // exercise the authority directly, bypassing tool visibility.
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("delegated-asks"))
        .await
        .unwrap();
    let repositories = BtccRepositories::new(storage.clone(), None);
    let (mut turn, _) = repositories
        .load_or_admit(&test_prepared_turn())
        .await
        .unwrap();
    let authority = PrincipalAuthority::new(
        storage.clone(),
        Arc::new(LocaleCollation::new("en-US").unwrap()),
        Arc::new(|| "2026-10-25T00:00:00.000Z".into()),
        Arc::new(|| uuid::Uuid::new_v4().to_string()),
    );
    turn.original_message = "Choose A".into();
    turn.original_message_id = "subsession-direction-message:direction".into();
    for (role, subsession) in [
        ("steward", json!(null)),
        ("worker", json!(null)),
        ("steward", json!({"executionMode":"read_only"})),
        ("worker", json!({"executionMode":"read_only"})),
        ("butler", json!({"executionMode":"read_only"})),
    ] {
        turn.context = json!({"executionPolicy":{"role":role,"trackingMode":"local",
            "workspacePath":"/tmp","subsession":subsession}});
        let result = authority
            .resolve_ask(
                &turn,
                false,
                ResolveAsk {
                    ask_id: ask_id.into(),
                    outcome: "answered".into(),
                    answer: Some("A".into()),
                    quote: "Choose A".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(result["error"]["code"], "not_user_turn", "{role}: {result}");
    }
    storage.close().await.unwrap();
    Ok(())
}
