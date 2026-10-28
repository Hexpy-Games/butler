//! Main-request history geometry, measured through the real provider boundary.
use super::*;
use butler_core::locale::LocaleCollation;
use butler_models::models::{ModelCatalog, ModelCatalogSnapshotInput, TokenEstimateInput};
use rusqlite::Connection;

#[tokio::test]
async fn per_turn_prompt_sizes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = catalog
        .snapshot(
            ModelCatalogSnapshotInput {
                configured_local: vec![],
                extra_models: vec![],
                registered_models: vec![],
                credential_views: vec![],
                default_model_ref: None,
                generated_at: "2026-01-01T00:00:00Z".into(),
            },
            &LocaleCollation::new("en-US").unwrap(),
        )
        .unwrap();
    for (model, window) in [
        ("anthropic/claude-sonnet-5", 1_000_000.0),
        ("anthropic/claude-haiku-4-5", 200_000.0),
    ] {
        assert_eq!(
            snapshot
                .resolve_model_metadata(Some(model))
                .context_window_tokens,
            Some(window)
        );
        measure(&catalog, &snapshot, model).await?;
    }
    Ok(())
}

async fn measure(
    catalog: &ModelCatalog,
    snapshot: &butler_models::models::ModelCatalogSnapshot,
    model: &str,
) -> Result<(), HarnessError> {
    let (mut s, stub, server) = start_with("off", "0", false, &[]).await?;
    stub.text_only
        .store(true, std::sync::atomic::Ordering::Relaxed);
    if model != "anthropic/claude-sonnet-5" {
        let saved =
            s.gw.post(
                "/credentials",
                json!({"provider_id":"anthropic", "api_key":"sk-ant-measure-placeholder"}),
            )
            .await?;
        let registered =
            s.gw.post(
                "/model-catalog/registered-models",
                json!({
            "provider_id":"anthropic","model_id":"claude-haiku-4-5","auth_type":"api_key",
            "credential_id":saved.data()["credential"]["id"]}),
            )
            .await?;
        assert_eq!(registered.status, 201, "{}", registered.text);
    }
    let selected = s
        .select_model(&ModelChoice {
            model: model.into(),
            effort: None,
        })
        .await?;
    assert_eq!(selected.status, 200, "{}", selected.text);
    s.turn("general", "measurement warmup").await?;
    s.agent.terminate().await?;
    seed(&s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    s.gw = s.agent.start_again().await?;
    for index in 0..3 {
        let start = stub.requests.lock().unwrap().len();
        let ask = format!("measurement latest {index}");
        let (_, turn) = s.turn("general", &ask).await?;
        assert_eq!(turn["state"], "delivered");
        let requests = stub.requests.lock().unwrap();
        let body = &requests[start];
        let prompt = body.to_string();
        assert!(prompt.contains(&ask));
        let recent = history(&s)?;
        for n in (36 + index)..40 {
            assert!(recent.contains(&format!("measurement user {n}:")));
            assert!(recent.contains(&format!("measurement answer {n}:")));
        }
        assert!(
            recent
                .find(&format!("measurement user {}:", 36 + index))
                .unwrap()
                < recent.find("measurement user 39:").unwrap()
        );
        for previous in 0..index {
            assert!(recent.contains(&format!("measurement latest {previous}")));
            assert!(recent.contains("butler: Cache fixture complete."));
        }
        let estimate = |text: &str| {
            catalog
                .estimate_tokens(snapshot, TokenEstimateInput::Text(text), Some(model))
                .map(|e| e.tokens)
        };
        let envelope = recent
            .lines()
            .filter(|line| line.starts_with("turn ") || line.starts_with("outcome "))
            .take(2)
            .collect::<Vec<_>>()
            .join("\n");
        eprintln!(
            "CHAT_HISTORY_HEADER model={model} bytes={} tokens={}",
            envelope.len(),
            estimate(&envelope).unwrap()
        );
        eprintln!(
            "CHAT_HISTORY_SIZE model={model} turn={index} prompt_bytes={} prompt_tokens={} recent_bytes={} recent_tokens={}",
            prompt.len(),
            estimate(&prompt).unwrap(),
            recent.len(),
            estimate(&recent).unwrap()
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

fn seed(path: &std::path::Path) -> Result<(), HarnessError> {
    let mut db = Connection::open(path)?;
    let tx = db.transaction()?;
    let session: String =
        tx.query_row("SELECT id FROM conversation_sessions LIMIT 1", [], |r| {
            r.get(0)
        })?;
    for index in 0..40 {
        let turn = format!("ct_measure_{index}");
        tx.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) VALUES(?1,?2,?3,'user','complete','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",rusqlite::params![turn,session,index+2])?;
        for (offset, role, label) in [(0, "user", "user"), (1, "assistant", "answer")] {
            let seq = index * 2 + offset + 3;
            let id = format!("cm_measure_{seq}");
            let text = format!(
                "measurement {label} {index}: {}",
                "ordinary history text ".repeat(30)
            );
            tx.execute("INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES(?1,?2,?3,?4,?5,'complete','user','imported','2026-01-01T00:00:00Z')",rusqlite::params![id,session,turn,seq,role])?;
            tx.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,'text',?3,'complete')",rusqlite::params![format!("cp_measure_{seq}"),id,json!({"text":text}).to_string()])?;
        }
    }
    tx.commit()?;
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    Ok(())
}
