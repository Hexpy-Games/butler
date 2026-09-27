//! I. Workspace files and sidebar space (SCENARIOS.md WS-01, WS-02).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::Reply;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::{Value, json};

async fn new_chat(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"kind": "chat", "title": title}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(format!(
        "s:{}",
        reply.data()["session"]["id"].as_str().unwrap_or_default()
    ))
}

async fn space(s: &Scenario) -> Result<Value, HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(navigation.status, 200, "{}", navigation.text);
    Ok(navigation.data()["space"].clone())
}

fn revision(space: &Value) -> i64 {
    space["revision"].as_i64().unwrap_or_default()
}

/// Keys of the children of `parent` (`None`: root), in sidebar order.
fn children(space: &Value, parent: Option<&str>) -> Vec<String> {
    let mut nodes: Vec<&Value> = space["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|node| node["parentKey"].as_str() == parent)
        .collect();
    nodes.sort_by(|a, b| {
        a["position"]
            .as_f64()
            .unwrap_or_default()
            .total_cmp(&b["position"].as_f64().unwrap_or_default())
    });
    nodes
        .iter()
        .filter_map(|node| node["key"].as_str().map(str::to_owned))
        .collect()
}

/// `pinned` of a session's `/navigation` chat summary (`key` is `s:<id>`).
async fn pinned(s: &Scenario, key: &str) -> Result<bool, HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    let id = key.trim_start_matches("s:");
    let chat = navigation.data()["chats"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|chat| chat["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("{id} missing from /navigation chats"));
    Ok(chat["pinned"] == true)
}

async fn mutate(s: &Scenario, path: &str, body: Value) -> Result<Reply, HarnessError> {
    let reply = s.gw.post(path, body).await?;
    assert_eq!(reply.status, 200, "{path}: {}", reply.text);
    Ok(reply)
}

/// WS-02 — Sidebar groups, moves, pins and undo show in `/navigation` and
/// persist; a stale revision changes nothing.
#[tokio::test]
async fn ws_02_sidebar_groups_moves_pins_undo() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("WS-02")?.start().await?;
    let alpha = new_chat(&s, "Alpha").await?;
    let beta = new_chat(&s, "Beta").await?;
    let gamma = new_chat(&s, "Gamma").await?;

    let created = mutate(
        &s,
        "/space/groups",
        json!({"expectedRevision": revision(&space(&s).await?), "title": "Garden", "parentKey": null}),
    )
    .await?;
    let group = format!("g:{}", created.data()["groupId"].as_str().unwrap());
    let view = space(&s).await?;
    assert!(
        view["groups"].to_string().contains("Garden") && children(&view, None).contains(&group),
        "{view}"
    );

    mutate(
        &s,
        "/space/moves",
        json!({"expectedRevision": revision(&view), "sourceKey": alpha, "targetKey": group, "position": "inside"}),
    )
    .await?;
    let view = space(&s).await?;
    assert_eq!(children(&view, Some(&group)), vec![alpha.clone()], "{view}");
    assert!(!children(&view, None).contains(&alpha));

    let before_move = children(&view, None);
    let moved = mutate(
        &s,
        "/space/moves",
        json!({"expectedRevision": revision(&view), "sourceKey": gamma, "targetKey": beta, "position": "after"}),
    )
    .await?;
    let view = space(&s).await?;
    let order = children(&view, None);
    let position = |key: &str| order.iter().position(|k| k == key).unwrap();
    assert_eq!(position(&gamma), position(&beta) + 1, "{order:?}");
    let token = moved.data()["undoToken"].as_str().unwrap().to_owned();
    mutate(
        &s,
        "/space/undo",
        json!({"expectedRevision": revision(&view), "undoToken": token}),
    )
    .await?;
    let view = space(&s).await?;
    assert_eq!(
        children(&view, None),
        before_move,
        "undo did not restore the order"
    );

    let stale = s
        .gw
        .post(
            "/space/moves",
            json!({"expectedRevision": revision(&view) - 1, "sourceKey": beta, "targetKey": group, "position": "inside"}),
        )
        .await?;
    assert!(
        (400..500).contains(&stale.status),
        "stale revision accepted: {}",
        stale.text
    );
    assert_eq!(space(&s).await?, view, "a rejected move changed the space");

    mutate(
        &s,
        "/space/pins",
        json!({"expectedRevision": revision(&view), "nodeKey": beta, "pinned": true}),
    )
    .await?;
    let view = space(&s).await?;
    assert!(pinned(&s, &beta).await?, "pin not shown in /navigation");

    s.restart().await?;
    assert_eq!(space(&s).await?, view, "space changed across restart");
    assert!(pinned(&s, &beta).await?, "pin lost across restart");
    s.finish().await
}
