//! Whole-turn history geometry and cache stability under both real catalog windows.
use super::*;
use butler_core::locale::LocaleCollation;
use butler_models::models::{ModelCatalog, ModelCatalogSnapshotInput, TokenEstimateInput};

#[tokio::test]
async fn token_windows_preserve_complete_newest_turns_and_hysteresis() -> Result<(), HarnessError> {
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
    for (model, budget) in [
        ("anthropic/claude-sonnet-5", 64_000usize),
        ("anthropic/claude-haiku-4-5", 24_000),
    ] {
        let (mut s, stub, server) = start_with("1h", "on", true, &[]).await?;
        stub.text_only
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if budget == 24_000 {
            register_small_model(&s).await?;
        }
        let selected = s
            .select_model(&ModelChoice {
                model: model.into(),
                effort: None,
            })
            .await?;
        assert_eq!(selected.status, 200, "{}", selected.text);
        s.turn("general", "window warmup").await?;
        s.agent.terminate().await?;
        let dbpath = s.sandbox.data.join("runtime/conversation-store.sqlite");
        let session = seed(&dbpath, 120, 2000)?;
        s.gw = s.agent.start_again().await?;
        let mut newest: Vec<_> = (116..120)
            .map(|n| {
                (
                    format!("filler {n} user: {}", "z".repeat(2000)),
                    format!("filler {n} answer: {}", "z".repeat(2000)),
                )
            })
            .collect();
        let mut previous = String::new();
        let mut previous_n = 0;
        let mut moves = 0;
        for index in 0..32 {
            let ask = format!(
                "window follow-up {index}: {}end",
                "history filler ".repeat(300)
            );
            let (_, turn) = s.turn("general", &ask).await?;
            assert_eq!(turn["state"], "delivered");
            let content = recent(&s)?;
            let tokens = butler_core::json::saturating_usize(
                catalog
                    .estimate_tokens(&snapshot, TokenEstimateInput::Text(&content), Some(model))
                    .unwrap()
                    .tokens,
            );
            assert!(tokens <= budget, "{model}: {tokens}>{budget}");
            let mut last = 0;
            for (user, answer) in &newest {
                let begin = content
                    .find(&format!("user: {user}\nbutler: {answer}"))
                    .unwrap();
                assert!(begin >= last, "newest complete turns must stay ordered");
                last = begin;
            }
            let first = content
                .lines()
                .find(|line| line.starts_with("turn "))
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let db = Connection::open(&dbpath)?;
            let n:usize=db.query_row("SELECT COUNT(*) FROM conversation_turns WHERE session_id=?1 AND completed_at IS NOT NULL AND seq<(SELECT seq FROM conversation_turns WHERE id=?2)",rusqlite::params![session,first],|r|r.get(0))?;
            assert!(content.starts_with(&format!(
                "Older turns omitted: {n} earlier turns of this chat are not shown below."
            )));
            if !previous.is_empty() {
                if n == previous_n {
                    assert!(
                        content.starts_with(&previous),
                        "history prefix changed without a whole-turn advance"
                    );
                } else {
                    assert!(n > previous_n);
                    assert!(tokens <= budget * 3 / 5, "advance must use 3/5 hysteresis");
                    moves += 1;
                }
            }
            eprintln!(
                "CHAT_WINDOW model={model} turn={index} tokens={tokens} budget={budget} omitted={n}"
            );
            previous = content;
            previous_n = n;
            newest.remove(0);
            newest.push((ask, "Cache fixture complete.".into()));
        }
        assert!(moves > 0, "fixture must cross the history boundary");
        s.finish().await?;
        server.abort();
    }
    Ok(())
}
