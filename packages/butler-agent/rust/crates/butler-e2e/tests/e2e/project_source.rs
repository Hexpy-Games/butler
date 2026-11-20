//! Attached project sources remain available on the butler's minimal tool surface.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]

use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    chatgpt_wire::functions,
    gateway::turn_state,
    provider::title_response,
    scenario::{Scenario, Setup, turn_timeout},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

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
            json!({"kind":"project","title":"Note","project_id":project}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().into())
}

/// Turn 1 writes the note; turn 2 reads the attached note, then answers.
fn respond(request: &Value) -> Option<ResponseRecord> {
    let input = request["input"].as_array()?;
    if input
        .iter()
        .any(|item| item["type"] == "function_call_output")
    {
        return Some(title_response("The code word is AMBER-17."));
    }
    if !functions(request).any(|tool| tool["name"] == "read_project_source") {
        return Some(title_response("Note: the code word is AMBER-17."));
    }
    let file_id = input
        .iter()
        .flat_map(|item| {
            item["content"].as_str().into_iter().chain(
                item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str()),
            )
        })
        .flat_map(str::lines)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|sources| sources.pointer("/0/originalRef/fileId").cloned())
        .expect("project source originalRef.fileId in the request");
    let item = json!({"type":"function_call","id":"fc_source","call_id":"call_source",
        "name":"read_project_source","arguments":json!({"file_id":file_id}).to_string(),
        "status":"completed"});
    Some(crate::ask_user::stub::response(&item))
}

#[tokio::test]
async fn project_source_attachment_is_read_and_answered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let s = Setup::new("PROJECT-SOURCE")?
        .stub_cassette(cassette)
        .env("BUTLER_PHASE_TOOL_SURFACE", "on")
        .start()
        .await?;
    s.provider()?.set_chat_responder(respond);
    let project_id = project(&s, "Attached note").await?;
    let chat_id = chat(&s, &project_id).await?;
    let (first_turn, _) = s.turn(&chat_id, "Write a note.").await?;
    let messages = s.gw.messages(&chat_id).await?;
    let note = messages
        .iter()
        .find(|message| {
            message["turn_id"] == first_turn
                && message["role"] == "assistant"
                && message["status"] == "delivered"
        })
        .expect("delivered note");
    let revision = format!(
        "{:x}",
        Sha256::digest(note["text"].as_str().unwrap().as_bytes())
    );
    let reply =
        s.gw.post(
            "/messages",
            json!({
                "chat_id":chat_id,"text":"What is the code word in the attached note?",
                "client_message_id":uuid::Uuid::new_v4().to_string(),
                "content_parts":{"version":1,"parts":[{"type":"project_source_ref",
                    "projectId":project_id,"titleSnapshot":"Note",
                    "source":{"kind":"message","id":note["id"],"revision":revision}}]}
            }),
        )
        .await?;
    let turn_id = s.gw.accepted_turn(reply.data()).await?;
    let terminal =
        s.gw.wait_terminal(&chat_id, &turn_id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let succeeded: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM btcc_guided_tool_calls WHERE turn_id=?1 \
         AND tool_name='read_project_source' AND status='completed' \
         AND json_extract(result_json,'$.ok')=1 AND instr(result_json,'AMBER-17')>0)",
        [&turn_id],
        |row| row.get(0),
    )?;
    assert!(
        succeeded,
        "read_project_source must return the note in turn {turn_id}"
    );
    s.finish().await
}
