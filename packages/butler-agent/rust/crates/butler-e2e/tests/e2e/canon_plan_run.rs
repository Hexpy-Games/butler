//! Ordered canon processing through the authenticated App boundary.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod batch_edits;
mod boundaries;
mod bundle;
mod closeout;
mod delete_replay;
mod deletion;
mod edits;
mod fixture;
mod holds;
mod idle;
mod lifecycle;
mod locking;
mod ordering;
mod queries;
mod replay_errors;
mod take_recovery;
mod taking;
mod visibility;
use butler_e2e::e2e::HarnessError;
use fixture::*;
use serde_json::json;

#[tokio::test]
async fn cb_07b_no_request_no_queue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, _, chat) = crate::canon_link::setup("CB-07B", false, false).await?;
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(view["chains"], json!([]));
    assert_eq!(s.gw.turns(&chat).await?, [] as [serde_json::Value; 0]);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM canon_session_queue", [], |r| r.get(0))?,
        0
    );
    drop(db);
    drop(script);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_07_plan_run_three_epics_in_canon_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) = crate::canon_link::setup("CB-07", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    *script.queue_request.lock().unwrap() = Some(json!({"op":"plan_run","plan_id":plan}));
    let turn = s.gw.say(&chat, "Run this plan").await?;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        std::time::Duration::from_secs(60),
    )
    .await?;
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(view["chains"][0]["steps"].as_array().unwrap().len(), 3);
    let keys = view["chains"][0]["steps"][0]["items"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        keys,
        std::collections::BTreeSet::from(["epic_id", "title", "canon_status", "state", "progress"])
    );
    for (index, epic) in epics.iter().enumerate() {
        assert_eq!(
            view["chains"][0]["steps"][index]["items"][0]["epic_id"],
            *epic
        );
    }
    script.wait_held().await;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
            [],
            |r| r.get(0)
        )?,
        1
    );
    drop(db);
    script.release();
    wait_done(&s, &chat, 3).await?;
    // Canon completion can precede the App's final reply projection.
    for turn in s.gw.turns(&chat).await? {
        s.gw.wait_terminal(
            &chat,
            turn["id"].as_str().unwrap(),
            std::time::Duration::from_secs(60),
        )
        .await?;
    }
    let messages = s.gw.messages(&chat).await?;
    assert!(messages.iter().all(|m| {
        m["role"] != "user"
            || !m["text"]
                .as_str()
                .unwrap_or_default()
                .starts_with("canon:epic/")
    }));
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["initiated"]["kind"] == "canon_step")
            .count(),
        3
    );

    s.finish().await?;
    server.abort();
    Ok(())
}
