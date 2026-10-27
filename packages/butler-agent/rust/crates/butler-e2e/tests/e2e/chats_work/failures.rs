//! Terminal failures, nonblocking quiet retries and change-driven visibility.
use super::*;
use butler_e2e::e2e::security::AdminClient;
use butler_platform::process_control::usage;
use std::sync::atomic::Ordering;

fn body(s: &Scenario, chat: &str) -> Value {
    json!({"relation_id":"failure","result_id":"failure","safe_title":"Evidence",
        "child_session_id":"child-failure","parent_chat_id":chat,"text":"Evidence ready.",
        "model_ref":s.model.model,"reasoning_effort":"low","access_mode":"full_access"})
}
async fn block(s: &Scenario) -> Result<(), HarnessError> {
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let current = admin
        .send(reqwest::Method::GET, "/hooks", None, &[])
        .await?;
    let command = if butler_platform::command_sandbox::POSIX_SHELL {
        "echo '{\"decision\":\"deny\",\"reason\":\"Blocked\"}'"
    } else {
        "echo {\"decision\":\"deny\",\"reason\":\"Blocked\"}"
    };
    let saved = admin.send(reqwest::Method::PUT, "/hooks", Some(json!({"revision":current.data()["revision"],
        "config":{"version":1,"hooks":[{"id":"guard","event":"UserPromptSubmit","type":"command","command":command,"timeout_ms":3000}]}})), &[]).await?;
    assert_eq!(saved.status, 200, "{saved:?}");
    Ok(())
}
fn attempt_count(s: &Scenario) -> i64 {
    app(s)
        .unwrap()
        .query_row(
            "SELECT attempts FROM app_initiated_messages WHERE kind='work_result'",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[tokio::test]
async fn permanent_failure_is_terminal_visible_once_and_idle_disk_stays_quiet()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    let (mut s, _) = setup("SS6-PERMANENT", &url).await?;
    // The same notice contract works outside the general chat.
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Evidence"}))
            .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"]
        .as_str()
        .unwrap_or_else(|| created.data()["id"].as_str().unwrap())
        .to_owned();
    block(&s).await?;
    let reply =
        s.gw.post("/internal/subsession-result", body(&s, &chat))
            .await?;
    assert_eq!(reply.status, 202, "{reply:?}");
    assert_eq!(reply.data()["state"], "failed");
    let messages = s.gw.messages(&chat).await?;
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert_eq!(
        messages[0]["text"],
        "작업 결과를 전달하지 못했어요 · 설정된 규칙에 의해 차단됨"
    );
    assert_eq!(messages[0]["initiated"]["kind"], "work_failed");
    assert_eq!(messages[0]["initiated"]["reason_code"], "hook_blocked");
    assert_eq!(messages[0]["initiated"]["work_session_id"], "child-failure");
    assert_eq!(attempt_count(&s), 1);
    s.crash_and_restart().await?;
    let replay =
        s.gw.post("/internal/subsession-result", body(&s, &chat))
            .await?;
    assert_eq!(replay.status, 202);
    assert_eq!(replay.data()["state"], "failed");
    assert_eq!(s.gw.messages(&chat).await?, messages);
    let mut watch = crate::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    let pid = s.agent.pid().unwrap();
    let before = usage::sample(pid)?.unwrap();
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after = usage::sample(pid)?.unwrap();
    let writes = after.write_bytes - before.write_bytes;
    eprintln!(
        "SS6 permanent_idle_seconds=60 write_bytes={writes} attempts={}",
        attempt_count(&s)
    );
    assert!(writes <= 1_000_000, "idle write budget exceeded: {writes}");
    watch.assert_unchanged();
    assert_eq!(attempt_count(&s), 1);
    assert_eq!(s.gw.messages(&chat).await?, messages);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn quiet_backoff_does_not_block_user_and_capped_retry_notice_is_once()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    let (mut s, address) = setup_with_failures("SS6-QUIET-RETRY", &url, "10").await?;
    s.patch_settings(json!({"timezone":"Asia/Seoul"}), "timezone")
        .await?;
    clock(&address, "2026-10-27T12:58:00.000Z").await?;
    let mut input = body(&s, "general");
    // Scheduled work observes quiet hours; user work bypasses them.
    let created = s.gw.post("/automations", json!({"title":"Evidence","prompt_body":"Check evidence.","target_session_id":"general","schedule_type":"once","run_at":"2099-01-01T00:00:00Z"})).await?;
    let schedule = created.data()["automation"]["id"].as_str().unwrap();
    input["schedule_run"] = json!({"automation_id":schedule,"run_id":"retry","unattended":true});
    assert_eq!(
        s.gw.post("/internal/subsession-result", input)
            .await?
            .status,
        503
    );
    // Replay the durable capped state without ten real-time backoff waits.
    app(&s)?.execute("UPDATE app_initiated_messages SET attempts=10,next_attempt_at='2026-10-27T13:03:00.000Z' WHERE kind='work_result'", [])?;
    clock(&address, "2026-10-27T13:00:00.000Z").await?;
    let started = Instant::now();
    let turn = accepted_turn_id(&s.gw.say("general", "Continue after the evidence.").await?)?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    eprintln!("SS6 backoff_user_ms={}", started.elapsed().as_millis());
    assert_eq!(attempt_count(&s), 10);
    s.gw.post("/sessions/general/read", json!({})).await?;
    held(&s, "work_failed", 1).await?;
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-10-27T13:00:00.000Z");
    s.crash_and_restart().await?;
    s.gw.post("/sessions/general/read", json!({})).await?;
    assert_eq!(
        app(&s)?.query_row(
            "SELECT count(*) FROM app_initiated_messages WHERE kind='work_failed'",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        1
    );
    clock(&address, "2026-10-27T22:00:00.000Z").await?;
    let notice = wait_count(&s, "work_failed", 1).await?;
    assert_eq!(notice[0]["initiated"]["reason_code"], "delivery_retrying");
    assert_eq!(
        notice[0]["initiated"]["reason_label"],
        "계속 다시 시도하고 있어요"
    );
    wait_count(&s, "work_result", 1).await?;
    held(&s, "work_result", 0).await?;
    assert_eq!(attempt_count(&s), 10);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn runtime_handles_permanent_result_failure_and_reclaims_handoff() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    let (s, _) = setup("SS6-RUNTIME-FAILED", &url).await?;
    let turn = accepted_turn_id(&s.gw.say("general", "Prepare evidence.").await?)?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    block(&s).await?;
    script.release.add_permits(1);
    let messages = wait_count(&s, "work_failed", 1).await?;
    assert_eq!(messages[0]["initiated"]["reason_code"], "hook_blocked");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let delivered: bool = runtime(&s)?.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_subsession_outbox WHERE status='delivered')",
            [],
            |r| r.get(0),
        )?;
        let raw: String = runtime(&s)?.query_row("SELECT final_payload_json FROM btcc_turns WHERE session_id IN (SELECT child_session_id FROM btcc_session_relations)", [], |r| r.get(0))?;
        let payload: Value = serde_json::from_str(&raw)?;
        let staged = payload["artifacts"][0]["stagedPath"].as_str().unwrap();
        if delivered && !std::path::Path::new(staged).exists() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "terminal result still owns its handoff; delivered={delivered}"
        );
        s.gw.events_since(0).await?;
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(attempt_count(&s), 1);
    assert_eq!(
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["initiated"]["kind"] == "work_failed")
            .count(),
        1
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
