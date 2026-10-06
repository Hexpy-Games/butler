//! Child corrections stay local; a second failed assignment belongs to the parent.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn child_repetition_and_parent_redelegation_have_separate_feedback()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false).await?;
    script.failing.store(true, Ordering::SeqCst);
    let mut s = Setup::new("DELEGATION-FAILURE-FEEDBACK")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    s.turn("general", stub::OWNER).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let first = loop {
        if let Some(child) = children(&s).await?.first()
            && let Some(relation) = child["relation"]["relation_id"].as_str()
        {
            break wait_blocked(&s, relation).await?;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let relation = first["relation"]["relation_id"].as_str().unwrap();
    *script.relation.lock().unwrap() = relation.to_owned();
    s.restart().await?;
    followup_turn(&s).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let children = children(&s).await?;
        if let Some(second) = children
            .iter()
            .find(|c| c["relation"]["relation_id"] != relation)
        {
            wait_blocked(&s, second["relation"]["relation_id"].as_str().unwrap()).await?;
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let requests = script.requests.lock().unwrap().clone();
    let child_requests: Vec<_> = requests
        .iter()
        .filter(|r| {
            butler_e2e::e2e::matching::key("/codex/responses", r, &Default::default())
                .user_request
                .starts_with("role: steward")
        })
        .collect();
    assert_eq!(
        child_requests
            .iter()
            .filter(|r| r.to_string().contains("occurred 4 times"))
            .count(),
        4
    );
    let parent_results: Vec<_> = requests
        .iter()
        .filter(|r| {
            butler_e2e::e2e::matching::key("/codex/responses", r, &Default::default())
                .user_request
                .contains("Delegated result")
        })
        .collect();
    assert_eq!(parent_results.len(), 2);
    assert!(
        parent_results
            .iter()
            .all(|r| !r.to_string().contains("occurred 4 times"))
    );
    assert!(
        parent_results[1]
            .to_string()
            .contains("The same delegation failed for the same reason 2 times")
    );
    assert!(
        parent_results[1]
            .to_string()
            .contains("Resolve this blocker or revise the Plan")
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM btcc_steward_results WHERE failure_key IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 2,
        "each child contributes one outcome, regardless of internal retries"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_blocked(s: &Scenario, relation: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let all = children(s).await?;
        let child = all
            .iter()
            .find(|c| c["relation"]["relation_id"] == relation)
            .unwrap();
        if child["result"].is_object() {
            assert_eq!(child["result"]["status"], "blocked", "{}", child["result"]);
            assert_eq!(child["result"]["work_status"], "blocked");
            let messages = s.gw.messages("general").await?;
            if messages
                .iter()
                .filter(|m| m["text"] == "원문 확인 결과를 정리했습니다.")
                .count() as u64
                >= child["relation"]["ordinal"].as_u64().unwrap()
            {
                return Ok(child.clone());
            }
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn duplicate_assignment_returns_the_running_relation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(true).await?;
    script.duplicate.store(true, Ordering::SeqCst);
    let s = Setup::new("DELEGATION-ALREADY-RUNNING")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_APP_SERVER_PORT", "0")
        .start()
        .await?;
    s.gw.say("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = {
            let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
                .unwrap();
            let mut query = db.prepare("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='delegate_to_steward' AND result_json IS NOT NULL ORDER BY rowid").unwrap();
            query
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        if rows.len() == 2 {
            let first: Value = serde_json::from_str(&rows[0])?;
            let second: Value = serde_json::from_str(&rows[1])?;
            assert_eq!(first["ok"], true);
            assert_eq!(second["ok"], false);
            assert_eq!(second["error"]["code"], "already_delegated");
            assert_eq!(first["relation_id"], second["relation_id"]);
            assert!(
                second["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("steer_steward")
            );
            assert_eq!(children(&s).await?.len(), 1);
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release.notify_one();
    s.finish().await?;
    server.abort();
    Ok(())
}
