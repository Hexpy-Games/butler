//! Oversized newest turns degrade deterministically without failing assembly.
use super::*;

#[tokio::test]
async fn oversized_recent_turns_fit_budget_and_keep_static_prefix() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, stub, server) = provider::start(false).await?;
    let s = Setup::new("PROMPT-HISTORY-OVER-BUDGET")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    s.turn("general", "warm history fixture").await?;
    let db = Connection::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    seed_large_turns(&db, 4, 30_000, &timestamp)?;

    let mut stable_prefix: Option<Vec<u8>> = None;
    for index in 0..4 {
        let start = stub.requests.lock().unwrap().len();
        let (_, turn) = s
            .turn("general", &format!("normal follow-up {index}"))
            .await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
        let request = stub.requests.lock().unwrap()[start].clone();
        let prefix = stable_layout_prefix(&request);
        if let Some(previous) = &stable_prefix {
            assert!(prefix.starts_with(previous), "static prompt prefix changed");
        } else {
            stable_prefix = Some(prefix);
        }
        let projected = history(&s.sandbox.data);
        let charged = serde_json::to_string(&projected)?.len() + "## Conversation history\n".len();
        assert!(charged <= 16_000, "history charged {charged} bytes");
        if index == 0 {
            assert!(projected.contains("user: "));
            assert!(projected.contains("butler: "));
            assert!(
                projected.contains("..."),
                "newest messages need excerpt markers"
            );
        }
    }

    s.finish().await?;
    server.abort();
    Ok(())
}

fn stable_layout_prefix(request: &Value) -> Vec<u8> {
    let text = source(request);
    let end = text.find("## Conversation history").unwrap();
    let mut bytes =
        serde_json::to_vec(&json!([request["instructions"], request["tools"]])).unwrap();
    bytes.extend_from_slice(text[..end].trim_end().as_bytes());
    bytes
}

fn seed_large_turns(
    db: &Connection,
    count: usize,
    chars: usize,
    timestamp: &str,
) -> Result<(), HarnessError> {
    let session: String =
        db.query_row("SELECT id FROM conversation_sessions LIMIT 1", [], |row| {
            row.get(0)
        })?;
    let mut turn_seq: u64 =
        db.query_row("SELECT MAX(seq)+1 FROM conversation_turns", [], |row| {
            row.get(0)
        })?;
    let mut message_seq: u64 =
        db.query_row("SELECT MAX(seq)+1 FROM conversation_messages", [], |row| {
            row.get(0)
        })?;
    let request = "u".repeat(chars);
    let reply = "a".repeat(chars);
    for index in 0..count {
        let turn_id = format!("ct_large_{index}");
        db.execute(
            "INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at,first_completed_at) VALUES(?1,?2,?3,'user','complete',?4,?4,?4)",
            rusqlite::params![turn_id, session, turn_seq, timestamp],
        )?;
        for (offset, role, text) in [(0, "user", &request), (1, "assistant", &reply)] {
            let message_id = format!("cm_large_{index}_{offset}");
            db.execute(
                "INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES(?1,?2,?3,?4,?5,'complete','user','imported',?6)",
                rusqlite::params![message_id, session, turn_id, message_seq, role, timestamp],
            )?;
            db.execute(
                "INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,'text',?3,'complete')",
                rusqlite::params![
                    format!("cp_large_{index}_{offset}"),
                    message_id,
                    json!({"text": text}).to_string()
                ],
            )?;
            message_seq += 1;
        }
        turn_seq += 1;
    }
    Ok(())
}
