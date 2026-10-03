//! Project artifact lookup through real chat transport and stub model calls.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "project_artifacts/scale.rs"]
mod scale;
#[path = "project_artifacts/stub.rs"]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    gateway::{tool_rows, turn_state},
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, time::Instant};

async fn project(s: &Scenario, name: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/projects", json!({"source":"scratch","display_name":name}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["project"]["id"].as_str().unwrap().into())
}

async fn chat(s: &Scenario, project: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","title":"Artifacts","project_id":project}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().into())
}

async fn lookup(s: &Scenario, chat: &str, prompt: &str) -> Result<Value, HarnessError> {
    let started = Instant::now();
    let (turn_id, turn) = s.turn(chat, prompt).await?;
    assert_eq!(
        turn_state(&turn),
        "delivered",
        "{turn}; replay misses: {:?}",
        s.provider()?.misses()
    );
    let rows = tool_rows(&s.gw.messages(chat).await?, &turn_id);
    assert_eq!(
        rows.iter()
            .filter(|r| r["safe_tool_name"] == "project_artifacts")
            .count(),
        1
    );
    eprintln!(
        "project artifact {prompt}: turn latency {:?}",
        started.elapsed()
    );
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (start,finish,raw): (String,String,String) = db.query_row(
        "SELECT started_at,finished_at,result_json FROM btcc_guided_tool_calls WHERE tool_name='project_artifacts' AND turn_id=?1",
        [&turn_id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    let elapsed = chrono::DateTime::parse_from_rfc3339(&finish).unwrap()
        - chrono::DateTime::parse_from_rfc3339(&start).unwrap();
    eprintln!(
        "project artifact {prompt}: tool duration {} ms",
        elapsed.num_milliseconds()
    );
    butler_e2e::assert_wall_clock_budget!(
        elapsed.to_std().unwrap(),
        std::time::Duration::from_millis(150),
        "project artifact call"
    );
    let durable: Value = serde_json::from_str(&raw)?;
    let request = s.provider()?.requests().last().unwrap().clone();
    let output = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|i| i["type"] == "function_call_output")
        .unwrap()["output"]
        .as_str()
        .unwrap();
    let visible: Value = serde_json::from_str(output)?;
    let mut visible = visible["output"].clone();
    visible.as_object_mut().unwrap().remove("tool_name");
    assert_eq!(
        visible, durable,
        "Model-visible output must preserve all metadata/content"
    );
    Ok(durable)
}

fn handle(s: &Scenario, item: &Value) -> Result<(), HarnessError> {
    s.provider()?
        .add_placeholder("FILE_ID", item["read_handle"]["id"].as_str().unwrap());
    s.provider()?.add_placeholder(
        "REVISION",
        item["read_handle"]["revision"].as_str().unwrap(),
    );
    Ok(())
}

fn revise(s: &Scenario, item: &Value, bytes: &[u8]) -> Result<(), HarnessError> {
    let id = item["id"].as_str().unwrap();
    fs::write(
        s.sandbox.data.join("app-server/message-files").join(id),
        bytes,
    )?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .unwrap();
    db.execute(
        "UPDATE message_files SET size_bytes=?1,sha256=?2 WHERE id=?3",
        rusqlite::params![bytes.len(), format!("{:x}", Sha256::digest(bytes)), id],
    )
    .unwrap();
    Ok(())
}

#[tokio::test]
async fn delivered_artifact_crosses_only_same_project_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("PROJECT-ARTIFACTS")?.stub_cassette(stub::cassette()?);
    let generated = setup.sandbox.data.join("artifacts/generated");
    fs::create_dir_all(&generated)?;
    let nonce = butler_e2e::e2e::nonce();
    let accepted = format!("Exact accepted bytes: {nonce}\n");
    fs::write(generated.join("accepted.txt"), &accepted)?;
    let mut scenario = setup.start().await?;
    let project_id = project(&scenario, "Shared files").await?;
    let origin_chat = chat(&scenario, &project_id).await?;
    let (origin_turn, published) = scenario.turn(&origin_chat, "Publish").await?;
    assert_eq!(turn_state(&published), "delivered", "{published}");
    let dashboard = scenario
        .gw
        .get(&format!("/projects/{project_id}/dashboard/artifacts"))
        .await?;
    assert_eq!(dashboard.status, 200, "{}", dashboard.text);
    assert_eq!(
        dashboard.data()["items"].as_array().unwrap().len(),
        1,
        "{dashboard:?}"
    );
    scenario
        .provider()?
        .add_placeholder("ORIGIN_SESSION", &origin_chat);
    scenario
        .provider()?
        .add_placeholder("ORIGIN_TURN", &origin_turn);
    scenario.restart().await?;
    let recall_chat = chat(&scenario, &project_id).await?;
    let found = lookup(&scenario, &recall_chat, "Find").await?;
    assert_eq!(found["total_count"], 1, "{found}");
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    let item = &found["items"][0];
    assert_eq!(item["title"], "accepted.txt");
    assert_eq!(item["type"], "text/plain");
    assert_eq!(item["size_bytes"], accepted.len());
    assert_eq!(item["origin_session"], origin_chat);
    assert_eq!(item["origin_turn"], origin_turn);
    let messages = scenario.gw.messages(&recall_chat).await?;
    assert!(messages.iter().any(|m| {
        m["text"]
            .as_str()
            .is_some_and(|t| t.contains(&origin_chat) && t.contains(&origin_turn))
    }));
    // File bytes must enter the model only following the explicit handle read.
    assert!(
        !scenario
            .provider()?
            .requests()
            .last()
            .unwrap()
            .to_string()
            .contains(&nonce)
    );
    handle(&scenario, item)?;
    let opened = lookup(&scenario, &recall_chat, "Open").await?;
    assert_eq!(opened["content"], accepted);
    assert!(
        scenario
            .provider()?
            .requests()
            .last()
            .unwrap()
            .to_string()
            .contains(&nonce)
    );
    assert_eq!(opened["total_bytes"], accepted.len());
    assert!(opened["next_cursor"].is_null());
    let other_project = project(&scenario, "Private files").await?;
    let other = chat(&scenario, &other_project).await?;
    let excluded = lookup(&scenario, &other, "Other").await?;
    assert_eq!(excluded["total_count"], 0);
    assert_eq!(excluded["items"], json!([]));
    assert_eq!(
        lookup(&scenario, &other, "Foreign").await?["error"],
        "source_unavailable"
    );
    assert_eq!(
        lookup(&scenario, "general", "General").await?["error"],
        "no_project"
    );
    assert_eq!(
        lookup(&scenario, &recall_chat, "Forged").await?["error"],
        "invalid_arguments"
    );
    revise(&scenario, item, b"latest accepted bytes")?;
    assert_eq!(
        lookup(&scenario, &recall_chat, "Stale").await?["error"],
        "source_snapshot_changed"
    );
    let latest = lookup(&scenario, &recall_chat, "Latest").await?;
    assert_eq!(latest["total_count"], 1);
    assert_eq!(latest["items"].as_array().unwrap().len(), 1);
    assert_eq!(latest["items"][0]["id"], item["id"]);
    assert_ne!(
        latest["items"][0]["read_handle"]["revision"],
        item["read_handle"]["revision"]
    );
    handle(&scenario, &latest["items"][0])?;
    assert_eq!(
        lookup(&scenario, &recall_chat, "Open").await?["content"],
        "latest accepted bytes"
    );
    check_read_guards(&scenario, &recall_chat, item).await?;
    fs::remove_file(
        scenario
            .sandbox
            .data
            .join("app-server/message-files")
            .join(item["id"].as_str().unwrap()),
    )?;
    assert_eq!(
        lookup(&scenario, &recall_chat, "Missing").await?["error"],
        "source_unavailable"
    );
    let db = butler_platform::sqlite::open(
        scenario
            .sandbox
            .data
            .join("app-server/butler-client.sqlite"),
    )
    .unwrap();
    db.execute(
        "DELETE FROM message_attachments WHERE file_id=?1",
        [item["id"].as_str().unwrap()],
    )
    .unwrap();
    assert_eq!(
        lookup(&scenario, &recall_chat, "Gone").await?["total_count"],
        0
    );
    assert_eq!(
        lookup(&scenario, &recall_chat, "Deleted").await?["error"],
        "source_unavailable"
    );
    drop(db);
    scenario.finish().await
}

async fn check_read_guards(s: &Scenario, b: &str, item: &Value) -> Result<(), HarnessError> {
    let large = format!(
        "{}{}{}",
        "한글🌿".repeat(3000),
        "\0".repeat(6000),
        "exact final bytes"
    );
    revise(s, item, large.as_bytes())?;
    let current = lookup(s, b, "Latest").await?;
    handle(s, &current["items"][0])?;
    let mut page = lookup(s, b, "Open").await?;
    let mut combined = String::new();
    let mut pages = 0;
    loop {
        assert_eq!(page["total_bytes"], large.len());
        assert_eq!(page["offset_bytes"], combined.len());
        combined.push_str(page["content"].as_str().unwrap());
        pages += 1;
        if page["next_cursor"].is_null() {
            break;
        }
        assert!(pages < 10, "content pagination did not advance");
        s.provider()?
            .add_placeholder("READ_CURSOR", page["next_cursor"].as_str().unwrap());
        page = lookup(s, b, "Continue").await?;
    }
    assert_eq!(combined, large);
    assert!(
        pages > 2,
        "control-heavy JSON must fit the existing result budget"
    );
    let binary = [0, 255, 128, 1, 2, 3];
    revise(s, item, &binary)?;
    let current = lookup(s, b, "Latest").await?;
    handle(s, &current["items"][0])?;
    let opened = lookup(s, b, "Open").await?;
    assert_eq!(opened["encoding"], "base64");
    use base64::Engine;
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(opened["content"].as_str().unwrap())
            .unwrap(),
        binary
    );
    let path = s
        .sandbox
        .data
        .join("app-server/message-files")
        .join(item["id"].as_str().unwrap());
    fs::write(&path, b"tampered")?;
    assert_eq!(lookup(s, b, "Open").await?["error"], "source_unavailable");
    fs::remove_file(&path)?;
    let outside = s.sandbox.root.join("outside-content");
    fs::write(&outside, binary)?;
    butler_platform::secure_fs::symlink(&outside, &path)?;
    assert_eq!(
        lookup(s, b, "Symlink").await?["error"],
        "source_unavailable"
    );
    fs::remove_file(&path)?;
    fs::write(&path, binary)?;
    Ok(())
}
