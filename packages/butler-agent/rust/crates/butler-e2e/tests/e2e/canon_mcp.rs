//! CN-10/11: external clients use only the loopback canon API through stdio MCP.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
mod pagination;
mod permissions;
mod proposals;
mod races;
mod writes;
use butler_e2e::e2e::{
    HarnessError,
    events::LiveEvents,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

fn canon_only(value: &Value) {
    match value {
        Value::Object(o) => {
            for (key, value) in o {
                assert!(
                    ![
                        "task_counts",
                        "running",
                        "sessions",
                        "session_ids",
                        "session_id",
                        "home_session_id",
                        "attachments",
                        "tasks",
                        "prompts",
                        "chats"
                    ]
                    .contains(&key.as_str()),
                    "forbidden key: {key}"
                );
                canon_only(value);
            }
        }
        Value::Array(a) => {
            for value in a {
                canon_only(value);
            }
        }
        _ => {}
    }
}
pub(super) async fn call(s: &Scenario, name: &str, args: Value) -> Result<Value, HarnessError> {
    let reply = butler_e2e::e2e::mcp::tool(
        &s.agent.launch,
        &s.sandbox.logs.join(format!("{name}.log")),
        json!({"name":"claude-code","title":"Claude Code","version":"0"}),
        name,
        args,
    )
    .await?;
    assert!(reply["error"].is_null(), "protocol error: {reply}");
    let value: Value =
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap())?;
    canon_only(&value);
    Ok(value)
}
async fn project(s: &Scenario) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Canon MCP"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["project"]["id"].as_str().unwrap().into())
}
async fn pending(s: &Scenario) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/canon/mcp-grants?state=pending").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let grants = reply.data()["grants"].as_array().unwrap();
    assert_eq!(grants.len(), 1);
    Ok(grants[0].clone())
}
async fn decide(s: &Scenario, id: &str, decision: &str) -> Result<(), HarnessError> {
    let reply =
        s.gw.post(&format!("/canon/mcp-grants/{id}/{decision}"), json!({}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(())
}
pub(super) async fn trust(s: &Scenario) -> Result<(), HarnessError> {
    assert_eq!(
        call(s, "canon_list", json!({})).await?["error"]["code"],
        "trust_pending"
    );
    decide(s, pending(s).await?["id"].as_str().unwrap(), "allow").await
}
#[tokio::test]
async fn cn_10_first_canon_call_asks_trust_then_lists() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CN-10")?.data_folder_token().start().await?;
    let project = project(&s).await?;
    let epic =
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Shared epic"}),
        )
        .await?
        .data()
        .clone();
    let stream = LiveEvents::subscribe(&s.gw, 0).await?;
    assert_eq!(
        call(&s, "canon_list", json!({"project":project})).await?["error"]["code"],
        "trust_pending"
    );
    let grant = pending(&s).await?;
    assert_eq!(grant["client_title"], "Claude Code");
    assert_eq!(grant["person"], "app-user");
    assert_eq!(grant["requested"].as_array().unwrap().len(), 5);
    let grant_id = grant["id"].as_str().unwrap();
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.trust_requested" && e["payload"]["grant_id"] == grant_id
        })
        .await?;
    assert_eq!(
        call(&s, "canon_list", json!({})).await?["error"]["code"],
        "trust_pending"
    );
    decide(&s, grant_id, "allow").await?;
    let page = call(&s, "canon_list", json!({"project":"Canon MCP"})).await?;
    assert_eq!(page["epics"][0]["id"], epic["id"]);
    let comment = call(
        &s,
        "canon_comment_epic",
        json!({"epic_id":epic["id"],"body":"Review\nDetails"}),
    )
    .await?;
    assert_eq!(comment["activity"][0]["actor"]["via"], "Claude Code");
    decide(&s, grant_id, "deny").await?;
    assert_eq!(
        call(&s, "canon_list", json!({})).await?["error"]["code"],
        "permission"
    );
    decide(&s, grant_id, "revoke").await?;
    assert_eq!(
        call(&s, "canon_list", json!({})).await?["error"]["code"],
        "trust_pending"
    );
    assert_eq!(pending(&s).await?["id"], grant["id"]);
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let count: i64 = db.query_row(
        "SELECT count(*) FROM canon_events WHERE topic='canon.trust_requested'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(count, 2, "first grant and revoke reopening only");
    drop(db);
    assert_eq!(
        call(&s, "canon_list", json!({})).await?["error"]["code"],
        "butler_not_running"
    );
    drop(stream);
    s.finish().await
}

fn store_error(error: &butler_canon::store::Error) -> HarnessError {
    butler_e2e::e2e::harness_error(error.to_string())
}
