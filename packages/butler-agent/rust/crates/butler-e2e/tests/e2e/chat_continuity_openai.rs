//! Real o200k underestimation must advance the render start only at capacity.
use super::*;
use butler_core::locale::LocaleCollation;
use butler_models::models::{ModelCatalog, ModelCatalogSnapshotInput, TokenEstimateInput};

#[tokio::test]
async fn chat_continuity_render_start_stays_sticky_with_o200k() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, stub, server) = provider::start(false).await?;
    let mut s = Setup::new("CHAT-CONTINUITY-O200K")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    s.turn("general", "warm up").await?;
    s.agent.terminate().await?;
    let payload = format!("{}end", "1234567890 ".repeat(250));
    seed_digits(
        &s.sandbox.data.join("runtime/conversation-store.sqlite"),
        &payload,
    )?;
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = catalog
        .snapshot(
            ModelCatalogSnapshotInput {
                configured_local: vec![],
                extra_models: vec![],
                registered_models: vec![],
                credential_views: vec![],
                default_model_ref: None,
                generated_at: "now".into(),
            },
            &LocaleCollation::new("en-US").unwrap(),
        )
        .unwrap();
    let estimate = |text: &str| {
        butler_core::json::saturating_usize(
            catalog
                .estimate_tokens(
                    &snapshot,
                    TokenEstimateInput::Text(text),
                    Some("openai/gpt-6-sol"),
                )
                .unwrap()
                .tokens,
        )
    };
    assert!(estimate(&payload) as f64 > payload.len() as f64 / 3.8);
    s.gw = s.agent.start_again().await?;
    let mut previous = String::new();
    let mut first = String::new();
    let mut stable = 0;
    let mut advances = 0;
    let mut newest: Vec<_> = (56..60)
        .map(|n| {
            (
                format!("digit user {n}: {payload}"),
                format!("digit answer {n}: {payload}"),
            )
        })
        .collect();
    for index in 0..24 {
        let ask = format!("digit follow-up {index}: {payload}");
        let request_index = stub.requests.lock().unwrap().len();
        let (_, turn) = s.turn("general", &ask).await?;
        assert_eq!(turn["state"], "delivered");
        let stored = history(&s.sandbox.data);
        let content = stored
            .strip_prefix("## Recent Conversation\n\n")
            .unwrap_or(&stored)
            .to_owned();
        assert!(source(&stub.requests.lock().unwrap()[request_index]).contains(&content));
        let tokens = estimate(&content);
        assert!(tokens <= 64_000, "{tokens}");
        let mut offset = 0;
        for (user, answer) in &newest {
            let position = content
                .find(&format!("user: {user}\nbutler: {answer}"))
                .unwrap();
            assert!(position >= offset);
            offset = position;
        }
        let current = content
            .lines()
            .find(|line| line.starts_with("turn "))
            .unwrap()
            .to_owned();
        if !previous.is_empty() {
            if current == first {
                assert!(
                    content.starts_with(&previous),
                    "all preceding turns must be byte-identical"
                );
                stable += 1;
            } else {
                assert!(tokens <= 64_000 * 3 / 5);
                advances += 1;
            }
        }
        eprintln!("CHAT_O200K turn={index} tokens={tokens} first={current}");
        first = current;
        previous = content;
        newest.remove(0);
        newest.push((ask, "once".into()));
    }
    assert!(
        stable >= 2,
        "fixture must exercise consecutive cached prefixes"
    );
    assert!(advances > 0, "fixture must exercise another render advance");
    s.finish().await?;
    server.abort();
    Ok(())
}

fn seed_digits(path: &std::path::Path, payload: &str) -> Result<(), HarnessError> {
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let session: String =
        tx.query_row("SELECT id FROM conversation_sessions LIMIT 1", [], |r| {
            r.get(0)
        })?;
    for index in 0..60 {
        let turn = format!("ct_digits_{index}");
        tx.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) VALUES(?1,?2,?3,'user','complete','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", rusqlite::params![turn,session,index+2])?;
        for (offset, role, label) in [(0, "user", "user"), (1, "assistant", "answer")] {
            let seq = index * 2 + offset + 3;
            let id = format!("cm_digits_{seq}");
            tx.execute("INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES(?1,?2,?3,?4,?5,'complete','user','imported','2026-01-01T00:00:00Z')", rusqlite::params![id,session,turn,seq,role])?;
            tx.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,'text',?3,'complete')", rusqlite::params![format!("cp_digits_{seq}"),id,json!({"text":format!("digit {label} {index}: {payload}")}).to_string()])?;
        }
    }
    tx.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}
