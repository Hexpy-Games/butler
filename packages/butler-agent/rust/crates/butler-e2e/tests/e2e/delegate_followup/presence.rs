//! Pin terminal-without-result and delivered-worker/resume admission windows.
use super::*;

#[tokio::test]
async fn terminal_child_without_result_releases_composer_followup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for state in ["delivered", "cancelled"] {
        let (s, script, server) = held(None).await?;
        let state = state.to_owned();
        mutate(&s, move |db| {
            assert_eq!(db.execute("UPDATE btcc_turns SET semantic_state=?1,suspension_reason=NULL WHERE session_id IN (SELECT child_session_id FROM btcc_session_relations)", [state]).unwrap(), 1);
            assert_eq!(db.query_row("SELECT count(*) FROM btcc_steward_results", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        }).await;
        let sent = s.gw.say("general", "Keep the closeout note.").await?;
        let turn = accepted_turn_id(&sent)?;
        let delivered =
            s.gw.wait_turn(
                "general",
                &turn,
                &["delivered", "failed"],
                Duration::from_secs(turn_timeout()),
            )
            .await?;
        assert_eq!(delivered["state"], "delivered", "{delivered}");
        script.release.notify_one();
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

#[tokio::test]
async fn child_read_failure_preserves_composer_admission() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, _, server) = stub::start(false).await?;
    let s = Setup::new("CHILD-PRESENCE-READ-FAILURE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_QUEUE_CLAIMS", "1")
        .start()
        .await?;
    // Native execution stays behind the existing ingress barrier until the
    // failed presence read is over and the table has been restored.
    mutate(&s, |db| {
        db.execute_batch("ALTER TABLE btcc_steward_results RENAME TO held_results")
            .unwrap();
    })
    .await;
    let sent = s.gw.say("general", "Keep the read-failure note.").await;
    mutate(&s, |db| {
        db.execute_batch("ALTER TABLE held_results RENAME TO btcc_steward_results")
            .unwrap();
    })
    .await;
    let turn = accepted_turn_id(&sent?)?;
    std::fs::write(s.sandbox.data.join("e2e-queue-claims-release"), b"once")?;
    let delivered =
        s.gw.wait_turn(
            "general",
            &turn,
            &["delivered", "failed"],
            Duration::from_secs(turn_timeout()),
        )
        .await?;
    assert_eq!(delivered["state"], "delivered", "{delivered}");
    s.finish().await?;
    server.abort();
    Ok(())
}

// test-category: race
#[tokio::test]
async fn delivered_worker_still_holds_followup_until_steward_resumes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use tokio::io::AsyncReadExt;
    let observer = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let (s, script, server) = held(Some(observer.local_addr()?.to_string())).await?;
    let messages = s.gw.messages("general").await?;
    let parent_turn = messages.iter().find(|m| m["role"] == "user").unwrap()["turn_id"]
        .as_str()
        .unwrap();
    mutate(&s, |db| {
        db.execute_batch("BEGIN;
            UPDATE btcc_turns SET suspension_reason='waiting_for_worker' WHERE session_id IN (SELECT child_session_id FROM btcc_session_relations);
            INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at)
            SELECT 'worker-relation',child_session_id,child_turn_id,'worker','worker-anchor',1,'Worker','now' FROM btcc_subsession_delegations JOIN btcc_session_relations USING(relation_id);
            INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,dispatch_state,created_at)
            VALUES('worker-delegation','worker-relation','worker-task','worker-turn','worker-work','{}','enqueued','now');
            INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence)
            VALUES('worker-turn','worker','worker-inbox','worker-trigger','worker-message','Request','snapshot','{}','{}','delivered',1,1);
            INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at)
            VALUES('worker-result','worker-relation','worker-task','worker','worker-turn','success','Complete','[]','[]','now');
            INSERT INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at)
            SELECT 'worker-outbox','worker-relation','worker-result',parent_session_id,parent_turn_id,'worker-result-message','{}','delivered','now' FROM btcc_session_relations WHERE relation_id='worker-relation';
            COMMIT;").unwrap();
    }).await;
    let followup = "Keep the resume note.";
    let sent = s.gw.say("general", followup).await?;
    assert!(sent["accepted"].is_null(), "{sent}");
    assert!(sent["queued"]["id"].is_string(), "{sent}");
    let (mut observed, _) = tokio::time::timeout(Duration::from_secs(10), observer.accept())
        .await
        .unwrap()?;
    let mut turn = String::new();
    observed.read_to_string(&mut turn).await?;
    assert_eq!(turn, parent_turn);
    assert!(
        !script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| ordering::request_text(r) == followup)
    );
    // Release the deterministic window and let the original provider complete.
    mutate(&s, |db| {
        db.execute("UPDATE btcc_turns SET suspension_reason=NULL WHERE suspension_reason='waiting_for_worker'", []).unwrap();
    }).await;
    script.release.notify_one();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "{}" && m["status"] == "delivered")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn held(
    observer: Option<String>,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(true).await?;
    let mut setup = Setup::new("CHILD-QUEUE-PRESENCE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    if let Some(observer) = observer {
        setup = setup.env("BUTLER_E2E_QUEUE_WAIT_OBSERVER", observer);
    }
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    Ok((s, script, server))
}

async fn mutate(s: &Scenario, change: impl FnOnce(&rusqlite::Connection) + Send + 'static) {
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    tokio::task::spawn_blocking(move || change(&rusqlite::Connection::open(path).unwrap()))
        .await
        .unwrap();
}
