//! Rolling context through real completion, restart, controls and deletion paths.
use super::*;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const SUMMARY: &str =
    "## Facts and entities\nKiwi is a female cockatiel.\n## Open threads\nContinue the chat.";
const FACT: &str = "My pet Kiwi is a female cockatiel.";
const HEADER: &str = "Summary of earlier turns of this chat, kept by Butler. Facts here were established in this chat; read_conversation_context returns exact wording.";

#[derive(Default)]
pub(super) struct Stub {
    requests: Mutex<Vec<Value>>,
}

pub(super) fn reply(stub: &Stub, body: &Value) -> Option<Value> {
    if !body["system"]
        .to_string()
        .contains("You keep the running summary of one chat")
    {
        return None;
    }
    stub.requests.lock().unwrap().push(body.clone());
    Some(
        json!({"id":"msg_summary","type":"message","role":"assistant","model":body["model"],
        "content":[{"type":"text","text":SUMMARY}],"stop_reason":"end_turn",
        "usage":{"input_tokens":100,"output_tokens":30}}),
    )
}

fn text(body: &Value) -> String {
    fn collect(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => out.push(text.clone()),
            Value::Array(items) => {
                for item in items {
                    collect(item, out);
                }
            }
            Value::Object(items) => {
                for item in items.values() {
                    collect(item, out);
                }
            }
            _ => (),
        }
    }
    let mut out = Vec::new();
    collect(&body["messages"], &mut out);
    out.join("\n")
}

fn summary_path(s: &Scenario, id: &str) -> PathBuf {
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    s.sandbox
        .data
        .join("cognition/memory/sessions")
        .join(format!("{}.md", &hash[..32]))
}

async fn settle(path: &Path, stub: &Arc<super::Stub>) -> Result<String, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut previous = String::new();
    let mut stable = Instant::now();
    loop {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        if text != previous {
            previous = text;
            stable = Instant::now();
        }
        if !previous.is_empty()
            && stub.continuity.requests.lock().unwrap().len() >= 2
            && stable.elapsed() >= Duration::from_secs(1)
        {
            return Ok(previous);
        }
        assert!(Instant::now() < deadline, "continuity fold did not settle");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn rolling_summary_restart_switch_idle_archive_and_delete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, stub, server) = start_with("1h", "on", true, &[]).await?;
    stub.text_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    register_small_model(&s).await?;
    let profiling =
        s.gw.patch("/personalization", json!({"profiling":{"mode":"off"}}))
            .await?;
    assert_eq!(profiling.status, 200, "{}", profiling.text);
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Continuity"}))
            .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let patched =
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"model":"anthropic/claude-haiku-4-5"}),
        )
        .await?;
    assert_eq!(patched.status, 200, "{}", patched.text);
    s.turn(&chat, FACT).await?;
    s.agent.terminate().await?;
    let dbpath = s.sandbox.data.join("runtime/conversation-store.sqlite");
    let id = seed(&dbpath, 32, 2600)?;
    let path = summary_path(&s, &id);
    s.gw = s.agent.start_again().await?;
    let (_, turn) = s
        .turn(&chat, "Continue from the previous discussion.")
        .await?;
    assert_eq!(turn["state"], "delivered");
    assert!(recent(&s)?.starts_with("Older turns omitted: "));
    let folded = settle(&path, &stub).await?;
    let requests = stub.continuity.requests.lock().unwrap().clone();
    assert!(text(&requests[0]).contains(FACT));
    assert!(text(&requests[0]).contains("butler (failed, not established): unestablished answer"));
    assert!(text(&requests[1]).contains(&format!("Current summary:\n{SUMMARY}\n\nNext turns")));
    assert!(!text(&requests[1]).contains(FACT));
    let mut folded_turns = std::collections::HashSet::new();
    for request in &requests {
        for line in text(request)
            .lines()
            .filter(|line| line.starts_with("[turn "))
        {
            assert!(
                folded_turns.insert(line.to_owned()),
                "already folded turn was sent again"
            );
        }
    }
    assert!(
        folded
            .lines()
            .next()
            .unwrap()
            .starts_with("<!-- butler-continuity {\"v\":1,\"through_seq\":")
    );
    verify_next(&s, &stub, &chat, &dbpath, &id).await?;
    idle(&path, &dbpath, &stub).await?;
    let count = stub.continuity.requests.lock().unwrap().len();
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    verify_next(&s, &stub, &chat, &dbpath, &id).await?;
    idle(&path, &dbpath, &stub).await?;
    assert_eq!(stub.continuity.requests.lock().unwrap().len(), count);
    let switched =
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"model":"anthropic/claude-sonnet-5"}),
        )
        .await?;
    assert_eq!(switched.status, 200, "{}", switched.text);
    verify_next(&s, &stub, &chat, &dbpath, &id).await?;
    for archived in [true, false] {
        let result =
            s.gw.patch(&format!("/sessions/{chat}"), json!({"archived":archived}))
                .await?;
        assert_eq!(result.status, 200, "{}", result.text);
        assert!(path.exists());
    }
    verify_next(&s, &stub, &chat, &dbpath, &id).await?;
    let deleted =
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    assert!(!path.exists());
    bulk_delete(&s).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn register_small_model(s: &Scenario) -> Result<(), HarnessError> {
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"anthropic","api_key":"sk-ant-continuity-placeholder"}),
        )
        .await?;
    let result=s.gw.post("/model-catalog/registered-models",json!({"provider_id":"anthropic","model_id":"claude-haiku-4-5","auth_type":"api_key","credential_id":saved.data()["credential"]["id"]})).await?;
    assert_eq!(result.status, 201, "{}", result.text);
    Ok(())
}

async fn verify_next(
    s: &Scenario,
    stub: &Arc<super::Stub>,
    chat: &str,
    dbpath: &Path,
    id: &str,
) -> Result<(), HarnessError> {
    let begin = stub.requests.lock().unwrap().len();
    let (_, turn) = s.turn(chat, "What species and sex is Kiwi?").await?;
    assert_eq!(turn["state"], "delivered");
    let body = stub.requests.lock().unwrap()[begin].clone();
    let prompt = text(&body);
    assert!(prompt.contains(&format!("{HEADER}\n\n{SUMMARY}")));
    assert!(!prompt.contains("<!-- butler-continuity"));
    let recent = recent(s)?;
    let first = recent
        .lines()
        .find(|l| l.starts_with("turn "))
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap();
    let db = Connection::open(dbpath)?;
    let omitted:u64=db.query_row("SELECT COUNT(*) FROM conversation_turns WHERE session_id=?1 AND completed_at IS NOT NULL AND seq<(SELECT seq FROM conversation_turns WHERE id=?2)",rusqlite::params![id,first],|r|r.get(0))?;
    if omitted > 0 {
        assert!(recent.starts_with(&format!(
            "Older turns omitted: {omitted} earlier turns of this chat are not shown below."
        )));
    }
    assert!(prompt.find(SUMMARY).unwrap() > prompt.find("## Current turn context").unwrap());
    Ok(())
}

fn recent(s: &Scenario) -> Result<String, HarnessError> {
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let content:String=db.query_row("SELECT content FROM btcc_context_documents WHERE source_id='recent-conversation' ORDER BY rowid DESC LIMIT 1",[],|r|r.get(0))?;
    Ok(content
        .strip_prefix("## Recent Conversation\n\n")
        .unwrap_or(&content)
        .to_owned())
}

async fn idle(path: &Path, dbpath: &Path, stub: &Arc<super::Stub>) -> Result<(), HarnessError> {
    let db = Connection::open(dbpath)?;
    let version: u64 = db.pragma_query_value(None, "data_version", |r| r.get(0))?;
    let modified = std::fs::metadata(path)?.modified()?;
    let count = stub.continuity.requests.lock().unwrap().len();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(count, stub.continuity.requests.lock().unwrap().len());
    assert_eq!(modified, std::fs::metadata(path)?.modified()?);
    assert_eq!(
        version,
        db.pragma_query_value::<u64, _>(None, "data_version", |r| r.get(0))?
    );
    eprintln!(
        "CHAT_CONTINUITY idle_summary_requests=0 idle_summary_writes=0 idle_conversation_changes=0 interval_ms=3000"
    );
    Ok(())
}

fn seed(path: &Path, count: u64, chars: usize) -> Result<String, HarnessError> {
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let session: String = tx.query_row(
        "SELECT id FROM conversation_sessions ORDER BY created_at DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let turn_seq: u64 = tx.query_row(
        "SELECT COALESCE(MAX(seq),0)+1 FROM conversation_turns WHERE session_id=?1",
        [&session],
        |r| r.get(0),
    )?;
    let mut seq: u64 = tx.query_row(
        "SELECT COALESCE(MAX(seq),0)+1 FROM conversation_messages WHERE session_id=?1",
        [&session],
        |r| r.get(0),
    )?;
    for index in 0..count {
        let turn = format!("ct_continuity_{index}");
        let status = if index == 0 { "failed" } else { "complete" };
        tx.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) VALUES(?1,?2,?3,'user',?4,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",rusqlite::params![turn,session,turn_seq+index,status])?;
        for (role, label) in [("user", "user"), ("assistant", "answer")] {
            let id = format!("cm_continuity_{seq}");
            let text = if index == 0 && role == "assistant" {
                "unestablished answer".into()
            } else {
                format!("filler {index} {label}: {}", "z".repeat(chars))
            };
            tx.execute("INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES(?1,?2,?3,?4,?5,'complete','user','imported','2026-01-01T00:00:00Z')",rusqlite::params![id,session,turn,seq,role])?;
            tx.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,'text',?3,'complete')",rusqlite::params![format!("cp_continuity_{seq}"),id,json!({"text":text}).to_string()])?;
            seq += 1;
        }
    }
    tx.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(session)
}

async fn bulk_delete(s: &Scenario) -> Result<(), HarnessError> {
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Continuity deletion"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{}", project.text);
    let project = project.data()["project"]["id"].as_str().unwrap();
    let mut paths = Vec::new();
    for index in 0..2 {
        let created =
            s.gw.post(
                "/sessions",
                json!({"kind":"project","title":format!("Bulk {index}"),"project_id":project}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        let session = &created.data()["session"];
        let chat = session["id"].as_str().unwrap();
        s.turn(chat, "Keep a transcript for deletion.").await?;
        let db = Connection::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
        let id:String=db.query_row("SELECT conversation_session_id FROM conversation_bindings WHERE gateway='app' AND external_session_id=?1",[session["session_hint"].as_str().unwrap()],|r|r.get(0))?;
        let path = summary_path(s, &id);
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, SUMMARY)?;
        // Delete every transport binding, including a different canonical conversation.
        let external = session["session_hint"].as_str().unwrap();
        db.execute(
            "UPDATE conversation_bindings SET gateway='mail' WHERE conversation_session_id=?1",
            [&id],
        )?;
        let other = format!("cs_transport_{index}");
        db.execute("INSERT INTO conversation_sessions SELECT ?1,workspace_id,project_id,'relay',created_at,updated_at,status,schema_version FROM conversation_sessions WHERE id=?2", rusqlite::params![other,id])?;
        db.execute(
            "INSERT INTO conversation_bindings VALUES('relay',?1,?2,'2026-01-01T00:00:00Z')",
            rusqlite::params![external, other],
        )?;
        let other_path = summary_path(s, &other);
        std::fs::write(&other_path, SUMMARY)?;
        paths.push(other_path);
        paths.push(path);
    }
    let deleted =
        s.gw.delete(&format!("/projects/{project}?permanent=true"))
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    assert!(paths.iter().all(|p| !p.exists()));
    Ok(())
}

#[path = "chat_continuity_window.rs"]
mod window;

#[path = "chat_continuity_fold_edge.rs"]
mod fold_edge;

#[path = "chat_continuity_contracts.rs"]
mod contracts;
