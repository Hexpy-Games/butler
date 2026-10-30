//! Unfinished delegated subtasks per conversation: the 세션 정보 panel's
//! session view and the sidebar's navigation list, through the real gateway.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod plans;
use super::steward_presentation::{self, stub};
use butler_e2e::e2e::{
    HarnessError,
    events::LiveEvents,
    scenario::{Access, Scenario},
};
use serde_json::Value;
use std::time::{Duration, Instant};

async fn started(id: &str, access: Option<Access>) -> Result<Started, HarnessError> {
    let (url, script, server) = stub::start().await?;
    let mut setup = steward_presentation::setup(id, &url)?;
    if let Some(access) = access {
        setup = setup.access(access);
    }
    for (name, text) in [("a.txt", "Approach A"), ("b.txt", "Approach B")] {
        std::fs::write(setup.sandbox.data.join(name), text)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    Ok(Started { s, script, server })
}

struct Started {
    s: Scenario,
    script: std::sync::Arc<stub::Script>,
    server: tokio::task::JoinHandle<()>,
}

async fn navigation_chat(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    Ok(navigation.data()["chats"]
        .as_array()
        .unwrap()
        .iter()
        .find(|chat| chat["id"] == id)
        .unwrap()
        .clone())
}

async fn general_view(s: &Scenario) -> Result<Value, HarnessError> {
    Ok(s.gw
        .get("/session-view?session_id=general")
        .await?
        .data()
        .clone())
}

#[tokio::test]
async fn working_subtask_is_listed_until_it_finishes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Started { s, script, server } = started("SUBTASKS-WORKING", None).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap_or_else(|_| panic!("child never held\n{}", s.agent.logs()));
    let view = general_view(&s).await?;
    let child = &view["steward_children"][0];
    let subtasks = view["subtasks"].as_array().unwrap();
    assert_eq!(subtasks.len(), 1, "{view}");
    let subtask = &subtasks[0];
    assert_eq!(subtask["session_id"], child["session_id"], "{subtask}");
    assert_eq!(subtask["relation_id"], child["relation"]["relation_id"]);
    assert_eq!(subtask["title"], child["title"]);
    assert_eq!(subtask["state"], "working", "{subtask}");
    assert_eq!(subtask["plan_total"], 2, "{subtask}");
    assert_eq!(subtask["plan_completed"], 1, "{subtask}");
    assert_eq!(subtask["started_at"], child["relation"]["created_at"]);
    // The sidebar row carries the same subtask; no attention, so no source.
    let parent = navigation_chat(&s, "general").await?;
    assert_eq!(parent["subtasks"], view["subtasks"], "{parent}");
    assert_eq!(parent["attention_required"], false, "{parent}");
    assert!(parent.get("attention_source").is_none(), "{parent}");
    let others = s.gw.get("/navigation").await?;
    assert!(
        others.data()["chats"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|chat| chat["id"] != "general")
            .all(|chat| chat.get("subtasks").is_none()),
        "{others:?}"
    );
    let cursor = live.snapshot().len();
    script.release.notify_one();
    let child_id = subtask["session_id"].as_str().unwrap().to_owned();
    finished_leaves(&s, &child_id).await?;
    // The removal reached the App as a pushed change, not by polling.
    assert!(
        live.snapshot()[cursor..].iter().any(|event| {
            event["type"] == "subsession.changed"
                && event["payload"]["child_session_id"] == child_id
        }),
        "no subsession.changed after the child finished"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A delivered child leaves both the panel's view and the sidebar row.
async fn finished_leaves(s: &Scenario, child: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = general_view(s).await?;
        let parent = navigation_chat(s, "general").await?;
        let done = view["steward_children"][0]["result"].is_object();
        if done && view["subtasks"] == serde_json::json!([]) && parent.get("subtasks").is_none() {
            assert_eq!(view["steward_children"][0]["session_id"], child);
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "finished subtask still listed: {view}\n{parent}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn subtask_approval_is_the_subtasks_attention_not_the_parents() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let Started { s, script, server } =
        started("SUBTASKS-APPROVAL", Some(Access::AskAlways)).await?;
    butler_e2e::e2e::fixtures::default_project_folder(&s).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    s.turn("general", stub::OWNER).await?;
    live.wait_for(Duration::from_secs(20), |e| {
        e["type"] == "pending_asks.changed"
            && e["payload"]["kind"] == "approval"
            && e["payload"]["state"] == "open"
            && e["payload"]["session_id"] == "general"
    })
    .await?;
    let view = general_view(&s).await?;
    let subtask = &view["subtasks"][0];
    assert_eq!(subtask["state"], "needs_approval", "{view}");
    let parent = navigation_chat(&s, "general").await?;
    assert_eq!(parent["attention_required"], true, "{parent}");
    assert_eq!(parent["attention_source"], "subtask", "{parent}");
    assert_eq!(parent["subtasks"][0]["state"], "needs_approval", "{parent}");
    // The same approval is also an ask of the owner chat (PA-03): the panel
    // lists it under 답을 기다리는 요청 and marks the subtask row.
    let asks = s.gw.get("/sessions/general/pending-asks").await?;
    let approval = &asks.data()["asks"][0];
    assert_eq!(approval["kind"], "approval", "{asks:?}");
    assert_eq!(approval["source_session_id"], subtask["session_id"]);
    println!(
        "SUBTASK-DUPLICATE ask={} source_session={} subtask_state={}",
        approval["ask_id"], approval["source_session_id"], subtask["state"]
    );
    // Both changes reach the App as pushed events naming the parent chat.
    let child = subtask["session_id"].clone();
    live.wait_for(Duration::from_secs(20), |e| {
        e["type"] == "subsession.changed" && e["payload"]["child_session_id"] == child
    })
    .await?;
    script.release.notify_one();
    server.abort();
    s.finish().await
}
