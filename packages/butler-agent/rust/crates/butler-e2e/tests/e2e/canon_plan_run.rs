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
mod delete_replay;
mod deletion;
mod edits;
mod fixture;
mod holds;
mod idle;
mod lifecycle;
mod locking;
mod ordering;
mod panel_history;
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

#[tokio::test]
async fn cn_17_completed_epic_never_starts_the_next_in_plan() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("CN-17", false, false).await?;
    let (plan, mut epics) = plan(&s, &script, &first).await?;
    let project = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200)["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    for title in ["Image tools", "Crate split"] {
        let epic = data(
            s.gw.post(
                &format!("/projects/{project}/canon/epics"),
                json!({"title":title,"plan_id":plan}),
            )
            .await?,
            201,
        );
        epics.push(epic["id"].as_str().unwrap().to_owned());
    }
    let overview = data(s.gw.get(&format!("/canon/plans/{plan}")).await?, 200);
    assert_eq!(overview["works"].as_array().unwrap().len(), 5);
    script.release();
    let turn = s.gw.say(&chat, "Process the release epic").await?;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&turn).await?,
        std::time::Duration::from_secs(60),
    )
    .await?;
    let epic = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200);
    assert_eq!(epic["canon_status"], "in_review", "{epic}");
    data(
        s.gw.patch(
            &format!("/canon/epics/{first}"),
            json!({"expected_revision":epic["revision"],"status":"done"}),
        )
        .await?,
        200,
    );
    let assert_idle = |s: &butler_e2e::e2e::scenario::Scenario| -> Result<(), HarnessError> {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        for (query, expected) in [
            ("SELECT count(*) FROM canon_session_queue", 0),
            (
                "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
                0,
            ),
            ("SELECT count(*) FROM canon_epic_work_links", 1),
        ] {
            assert_eq!(
                db.query_row::<i64, _, _>(query, [], |r| r.get(0))?,
                expected,
                "{query}"
            );
        }
        Ok(())
    };
    assert_idle(&s)?;
    s.restart().await?;
    assert_idle(&s)?;
    assert_eq!(s.gw.turns(&chat).await?.len(), 1);
    let overview = data(s.gw.get(&format!("/canon/plans/{plan}")).await?, 200);
    assert_eq!(overview["progress"], json!({"total":5,"done":1}));
    for epic in &epics[1..] {
        let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
        assert_eq!(row["canon_status"], "planned", "{row}");
        let progress = data(
            s.gw.get(&format!("/canon/epics/{epic}/progress")).await?,
            200,
        );
        assert_eq!(progress["running"], false);
        assert_eq!(progress["counts"]["total"], 0);
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
