//! Transient result delivery retains durable priority and exactly-once admission.
use super::*;
use std::sync::atomic::Ordering;

async fn attempts(s: &Scenario, count: i64) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let n: i64 = app(s)?.query_row(
            "SELECT COALESCE(max(attempts),0) FROM app_initiated_messages WHERE kind='work_result'",
            [],
            |r| r.get(0),
        )?;
        if n == count {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "attempts={n}, expected={count}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn queued_done(s: &Scenario) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let messages = s.gw.messages("general").await?;
        if let Some(turn) = messages
            .iter()
            .find(|m| m["text"] == "Continue after the evidence.")
            .and_then(|m| m["turn_id"].as_str())
        {
            s.gw.wait_terminal("general", turn, Duration::from_secs(30))
                .await?;
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "queued user message never admitted: {messages:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn transient_send_twice_then_exactly_once_without_blocking_user_queue()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    let (s, address) = setup_with_failures("SS6-RETRY", &url, "2").await?;
    let body = json!({"relation_id":"delivery","result_id":"delivery","safe_title":"Evidence",
        "child_session_id":"child-delivery","parent_chat_id":"general","text":"Evidence is ready.",
        "model_ref":s.model.model,"reasoning_effort":s.model.effort.clone().unwrap_or_else(|| "low".into()),"access_mode":"full_access"});
    let response =
        s.gw.post("/internal/subsession-result", body.clone())
            .await?;
    assert_eq!(response.status, 503, "{response:?}");
    attempts(&s, 1).await?;
    let queued = s.gw.say("general", "Continue after the evidence.").await?;
    assert!(queued["accepted"].is_object(), "{queued:?}");
    queued_done(&s).await?;
    let replay =
        s.gw.post("/internal/subsession-result", body.clone())
            .await?;
    assert_eq!(replay.status, 202, "{replay:?}");
    assert_eq!(replay.data()["held"], true);
    clock(&address, "2026-10-27T12:00:01.000Z").await?;
    attempts(&s, 2).await?;
    held(&s, "work_result", 1).await?;
    assert_eq!(
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["initiated"]["kind"] == "work_result")
            .count(),
        0
    );
    let started = Instant::now();
    clock(&address, "2026-10-27T12:00:03.000Z").await?;
    wait_count(&s, "work_result", 1).await?;
    queued_done(&s).await?;
    let messages = s.gw.messages("general").await?;
    let order: Vec<String> = app(&s)?
        .prepare("SELECT text FROM messages WHERE role='user' ORDER BY rowid")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    assert_eq!(
        order,
        ["Continue after the evidence.", "Evidence is ready."]
    );
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["initiated"]["kind"] == "work_result")
            .count(),
        1
    );
    assert_eq!(
        s.gw.post("/internal/subsession-result", body).await?.status,
        202
    );
    assert_eq!(app(&s)?.query_row("SELECT count(*) FROM turns WHERE json_extract(execution_controls_json,'$.subsession_result.result_id')='delivery'", [], |r| r.get::<_,i64>(0))?, 1);
    eprintln!("SS6 retry_release_ms={}", started.elapsed().as_millis());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn queued_result_keeps_files_until_its_consuming_turn_finishes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    let (s, _) = setup("SS6-QUEUED-FILES", &url).await?;
    let turn = s.gw.say_turn("general", "Prepare evidence.").await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    script.parent_hold.store(true, Ordering::SeqCst);
    let busy =
        s.gw.say_turn("general", "Keep this conversation active.")
            .await?;
    tokio::time::timeout(Duration::from_secs(30), script.parent_held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    script.release.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let queued: bool = app(&s)?.query_row("SELECT EXISTS(SELECT 1 FROM app_initiated_messages WHERE kind='work_result' AND state='posted' AND message_id IS NULL)", [], |r| r.get(0))?;
        let delivered: bool = runtime(&s)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_subsession_outbox WHERE status='delivered')",
            [],
            |r| r.get(0),
        )?;
        if queued && delivered {
            break;
        }
        assert!(Instant::now() < deadline, "result was not durably queued");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // A gateway command and event drain let the reclaimer observe the delivered receipt.
    s.gw.events_since(0).await?;
    let files: String = runtime(&s)?.query_row("SELECT final_payload_json FROM btcc_turns WHERE session_id IN (SELECT child_session_id FROM btcc_session_relations)", [], |r| r.get(0))?;
    let payload: Value = serde_json::from_str(&files)?;
    let staged = payload["artifacts"][0]["stagedPath"].as_str().unwrap();
    assert!(std::path::Path::new(staged).is_file());
    script.parent_release.add_permits(1);
    s.gw.wait_terminal("general", &busy, Duration::from_secs(30))
        .await?;
    let messages = wait_count(&s, "work_result", 1).await?;
    let attachments = messages[0]["attachments"].as_array().unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0]["safe_name"], "report.md");
    let file = s.gw.get(attachments[0]["url"].as_str().unwrap()).await?;
    assert_eq!(file.status, 200);
    assert!(file.text.contains("Complete evidence document."));
    s.finish().await?;
    server.abort();
    Ok(())
}
