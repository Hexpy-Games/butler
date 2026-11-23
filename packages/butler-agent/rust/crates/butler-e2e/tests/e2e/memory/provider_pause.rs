//! Semantic projection resumes after provider pauses and legacy failures.
use super::memory_stubs;
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    fixtures,
    provider::title_response,
    scenario::{Fixture, Setup},
};
use butler_platform::sqlite;
use rusqlite::params;
use serde_json::json;
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

#[tokio::test]
async fn mem_projection_quota_pause_waits_uncharged() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let message = "My usual breakfast changed from cereal to toast.";
    let mut cassette = Cassette::load("MEM-01")?;
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = message.into();
    answer.request.key.round.clear();
    answer.response = title_response("Noted.");
    cassette.exchanges.push(answer);
    let setup = Setup::new("MEM-PROJECTION-QUOTA-PAUSE")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .unset_env("BUTLER_E2E_APP_NOW");
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, &chrono::Utc::now().to_rfc3339())?;
    let s = setup.start().await?;
    s.select_model(&s.model).await?;
    s.provider()?.set_memory_responder(|request| {
        static REQUESTS: AtomicUsize = AtomicUsize::new(0);
        if REQUESTS.fetch_add(1, Ordering::Relaxed) < 4 {
            return ResponseRecord {
                status: 429,
                headers: vec![
                    ("content-type".into(), "application/json".into()),
                    ("retry-after".into(), "1".into()),
                ],
                chunks: vec![Chunk {
                    delay_ms: 0,
                    text: r#"{"error":{"code":"insufficient_quota"}}"#.into(),
                }],
            };
        }
        let prompt = request["input"]
            .as_str()
            .or_else(|| request["input"][0]["content"][0]["text"].as_str())
            .unwrap();
        let input: serde_json::Value = serde_json::from_str(prompt).unwrap();
        let items = if input["speaker"] == "user" {
            json!([{"kind":"change","subject":null,"field":"usual breakfast","old":"cereal","new":"toast","evidence":[0]}])
        } else {
            json!([])
        };
        title_response(
            &json!({"status":"processed","entities":[],"items":items,"attributes":[]}).to_string(),
        )
    });
    s.provider()?.set_chat_responder(|request| {
        (request["text"]["format"]["name"] == "memory_binding0_v4").then(|| {
            title_response(
                r#"{"decisions":[{"target":"f0","candidate":null,"span":null,"support":[]}]}"#,
            )
        })
    });
    let (turn, _) = s.turn("general", message).await?;
    let source = format!("conversation_turn:{turn}");
    let job: String = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if let Ok(graph) = memory_stubs::graph_path(&s.sandbox.data) {
                let db = sqlite::open_with_flags(graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                let job = db.query_row(
                    "SELECT j.job_id FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id
                     JOIN memory_projection_windows w ON w.job_id=j.job_id WHERE c.source_key=?1
                     GROUP BY j.job_id HAVING COUNT(*)=2 AND SUM(w.state='complete')=COUNT(*)",
                    [&source],
                    |row| row.get(0),
                );
                match job {
                    Ok(job) => return Ok::<_, HarnessError>(job),
                    Err(rusqlite::Error::QueryReturnedNoRows) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("both windows must complete after a quota pause")?;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let db = sqlite::open_with_flags(graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let (paused, provider_failed): (i64, i64) = db.query_row(
        "SELECT COUNT(*) FILTER (WHERE state='failed' AND error_code='memory_extract_provider_paused'),
                COUNT(*) FILTER (WHERE error_code='memory_extract_provider_failed')
         FROM memory_projection_attempts WHERE job_id=?1",
        [&job],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    assert!(paused >= 4, "paused attempts must exceed the cap: {paused}");
    assert_eq!(provider_failed, 0);
    let failed_windows: i64 = db.query_row(
        "SELECT COUNT(*) FROM memory_projection_windows WHERE job_id=?1 AND state='failed'",
        [&job],
        |row| row.get(0),
    )?;
    assert_eq!(failed_windows, 0);
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn mem_projection_long_reply_window_completes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let message = memory_stubs::ORDINARY_MESSAGES[0];
    let last = "The final notebook is on the table.";
    let reply = format!(
        "{}{last}",
        "The shelves hold books, notebooks, and neatly folded maps. ".repeat(100)
    );
    let mut cassette = Cassette::load("MEM-01")?;
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = message.into();
    answer.request.key.round.clear();
    answer.response = title_response(&reply);
    cassette.exchanges.push(answer);
    let setup = Setup::new("MEM-PROJECTION-LONG-REPLY")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .unset_env("BUTLER_E2E_APP_NOW");
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, &chrono::Utc::now().to_rfc3339())?;
    let s = setup.start().await?;
    s.select_model(&s.model).await?;
    s.provider()?.set_memory_responder(|_| {
        title_response(r#"{"status":"processed","entities":[],"items":[],"attributes":[]}"#)
    });
    let (turn, _) = s.turn("general", message).await?;
    let source = format!("conversation_turn:{turn}");
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if let Ok(graph) = memory_stubs::graph_path(&s.sandbox.data) {
                let db =
                    sqlite::open_with_flags(graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                let complete: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM memory_projection_windows w
                     JOIN memory_projection_jobs j ON j.job_id=w.job_id
                     JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id
                     WHERE c.source_key=?1 AND w.ordinal=1 AND w.state='complete')",
                    [&source],
                    |row| row.get(0),
                )?;
                if complete {
                    return Ok::<_, HarnessError>(());
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the assistant window must complete")?;
    assert!(s.provider()?.memory_requests().iter().any(|request| {
        request["input"]
            .as_str()
            .or_else(|| request["input"][0]["content"][0]["text"].as_str())
            .and_then(|prompt| serde_json::from_str::<serde_json::Value>(prompt).ok())
            .is_some_and(|prompt| {
                prompt["speaker"] == "assistant"
                    && prompt["parts"].as_array().is_some_and(|parts| {
                        parts.iter().any(|part| {
                            part["text"]
                                .as_str()
                                .is_some_and(|text| text.contains(last))
                        })
                    })
            })
    }));
    let db = sqlite::open_with_flags(
        memory_stubs::graph_path(&s.sandbox.data)?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let budget_failures: i64 = db.query_row(
        "SELECT COUNT(*) FROM memory_projection_attempts
         WHERE error_code='memory_extract_source_window_exceeds_budget'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(budget_failures, 0);
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn mem_projection_failed_windows_requeue_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("MEM-01")?;
    memory_stubs::ordinary(&mut cassette);
    let setup = Setup::new("MEM-PROJECTION-FAILED-REQUEUE")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .unset_env("BUTLER_E2E_APP_NOW");
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, &chrono::Utc::now().to_rfc3339())?;
    let mut s = setup.start().await?;
    s.select_model(&s.model).await?;
    s.provider()?.set_memory_responder(|_| {
        title_response(r#"{"status":"processed","entities":[],"items":[],"attributes":[]}"#)
    });
    let gate = s.provider()?.hold_next_reply("\"speaker\":\"user\"");
    s.turn("general", memory_stubs::ORDINARY_MESSAGES[0])
        .await?;
    tokio::time::timeout(Duration::from_secs(90), async {
        while s.provider().unwrap().memory_requests().is_empty() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the held meaning request must reach the provider");
    s.agent.kill9()?;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let db = sqlite::open(&graph)?;
    let job: String = db.query_row(
        "SELECT job_id FROM memory_projection_windows WHERE state='running' AND ordinal=0",
        [],
        |row| row.get(0),
    )?;
    let before: Vec<Option<String>> = db
        .prepare(
            "SELECT recovery_revision FROM memory_projection_windows WHERE job_id=?1 ORDER BY ordinal",
        )?
        .query_map([&job], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for attempt in 1..=3 {
        db.execute(
            "INSERT INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision)
             SELECT window_ref||':seeded:'||?2,window_ref,job_id,?2,'failed','memory_extract_provider_failed',
                    started_at,'provider',1,1,'seeded-'||?2,recovery_revision FROM memory_projection_windows WHERE job_id=?1 AND ordinal=0",
            params![job, attempt],
        )?;
    }
    db.execute(
        "UPDATE memory_projection_windows SET state='failed',error_code='memory_extract_provider_failed',
         attempt_count=3,owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE job_id=?1 AND ordinal=0",
        [&job],
    )?;
    db.execute(
        "UPDATE memory_projection_windows SET state='failed',error_code='memory_extract_source_window_exceeds_budget',
         input_json=NULL WHERE job_id=?1 AND ordinal=1",
        [&job],
    )?;
    db.execute(
        "DELETE FROM memory_state WHERE key='provider_pause_recovery'",
        [],
    )?;
    drop(db);
    gate.release();
    s.gw = s.agent.start_again().await?;
    sqlite::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?.execute(
        "UPDATE conversation_public_source_state SET revision=revision+1 WHERE singleton=1",
        [],
    )?;
    let db = sqlite::open_with_flags(&graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let complete: i64 = db.query_row(
                "SELECT COUNT(*) FROM memory_projection_windows WHERE job_id=?1 AND state='complete'",
                [&job],
                |row| row.get(0),
            )?;
            if complete == 2 {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("both requeued windows must complete")?;
    let after: Vec<Option<String>> = db
        .prepare(
            "SELECT recovery_revision FROM memory_projection_windows WHERE job_id=?1 ORDER BY ordinal",
        )?
        .query_map([&job], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    assert_eq!(before.len(), 2);
    assert_eq!(after.len(), 2);
    for (before, after) in before.iter().zip(&after) {
        assert_ne!(before, after);
    }
    let seeded: i64 = db.query_row(
        "SELECT COUNT(*) FROM memory_projection_attempts
         WHERE job_id=?1 AND attempt_ref=window_ref||':seeded:'||attempt_count",
        [&job],
        |row| row.get(0),
    )?;
    assert_eq!(seeded, 3);
    let state: String = db.query_row(
        "SELECT json_extract(semantic_graph_state,'$.state') FROM memory_projection_jobs WHERE job_id=?1",
        [&job],
        |row| row.get(0),
    )?;
    assert_eq!(state, "complete");
    let migrated: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_state WHERE key='provider_pause_recovery')",
        [],
        |row| row.get(0),
    )?;
    assert!(migrated);
    drop(db);
    s.finish().await
}
