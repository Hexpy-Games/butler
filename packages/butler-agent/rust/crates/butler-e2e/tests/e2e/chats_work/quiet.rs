//! Quiet decisions apply in every chat and latest instructions decide attendance.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn project_result_posts_during_quiet_hours_with_stable_live_and_read_flag()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    let (mut s, address) = setup("SS6-PROJECT-QUIET", &url).await?;
    let folder = s.sandbox.root.join("projects");
    std::fs::create_dir_all(&folder)?;
    let chat = crate::project_workspace::bind_project(&mut s, &folder).await?;
    clock(&address, "2026-10-28T06:59:59.000Z").await?;
    let response = s.gw.post("/internal/subsession-result", json!({"relation_id":"project-result","result_id":"project-result",
        "safe_title":"Evidence","child_session_id":"child-project","parent_chat_id":chat,"text":"Evidence is ready.",
        "model_ref":s.model.model,"reasoning_effort":s.model.effort.clone().unwrap_or_else(|| "low".into()),"access_mode":"full_access"})).await?;
    assert_eq!(response.status, 202, "{response:?}");
    let turn = s.gw.accepted_turn(response.data()).await?;
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    let messages = s.gw.messages(&chat).await?;
    let result = messages.iter().find(|m| m["role"] == "assistant").unwrap();
    assert_eq!(result["quiet"], true);
    assert_eq!(result["initiated"]["quiet"], true);
    assert!(
        s.gw.events_since(0)
            .await?
            .iter()
            .any(|e| e["payload"]["message"]["id"] == result["id"]
                && e["payload"]["message"]["quiet"] == true)
    );
    clock(&address, "2026-10-28T12:00:00.000Z").await?;
    assert_eq!(
        s.gw.messages(&chat)
            .await?
            .iter()
            .find(|m| m["id"] == result["id"])
            .unwrap()["quiet"],
        true
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn schedule_work_steered_by_user_posts_immediately_and_quietly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    let (s, address) = setup("SS6-STEER-ORIGIN", &url).await?;
    let created = s.gw.post("/automations", json!({"title":"Evidence schedule","prompt_body":"Prepare evidence.","target_session_id":"general",
        "schedule_type":"once","run_at":"2000-01-01T00:00:00Z","access_mode":"full_access"})).await?;
    assert_eq!(created.status, 201, "{created:?}");
    assert_eq!(
        s.gw.post("/automations/dispatch-due", json!({}))
            .await?
            .status,
        202
    );
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let (relation, child): (String, String) = runtime(&s)?.query_row(
        "SELECT relation_id,child_session_id FROM btcc_session_relations",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    *script.relation.lock().unwrap() = relation;
    clock(&address, "2026-10-28T06:59:59.000Z").await?;
    let turn =
        s.gw.say_turn("general", "Check the evidence again.")
            .await?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    let started = Instant::now();
    script.release.add_permits(1);
    let messages = wait_count(&s, "work_result", 1).await?;
    let applied: i64 = runtime(&s)?.query_row("SELECT count(*) FROM btcc_subsession_directions d JOIN btcc_steward_results r ON r.child_turn_id=d.applied_child_turn_id WHERE d.status='applied' AND r.status='success'", [], |r| r.get(0))?;
    assert_eq!(applied, 1);
    assert!(
        messages
            .iter()
            .all(|m| m["quiet"] == true && m["initiated"]["work_session_id"] == child)
    );
    let raw: String = runtime(&s)?.query_row(
        "SELECT input_json FROM btcc_subsession_outbox ORDER BY rowid DESC LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let input: Value = serde_json::from_str(&raw)?;
    assert_eq!(input["schedule_run"]["unattended"], false);
    assert_eq!(input["schedule_run"]["automation_id"], "");
    held(&s, "work_result", 0).await?;
    eprintln!("SS6 user_steer_result_ms={}", started.elapsed().as_millis());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn quiet_is_decided_when_reply_posts_after_admission() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    script.parent_hold.store(true, Ordering::SeqCst);
    let (s, address) = setup("SS6-POST-QUIET", &url).await?;
    let response = s.gw.post("/internal/subsession-result", json!({"relation_id":"post-time","result_id":"post-time",
        "safe_title":"Evidence","child_session_id":"child-post","parent_chat_id":"general","text":"Evidence ready.",
        "model_ref":s.model.model,"reasoning_effort":"low","access_mode":"full_access"})).await?;
    assert_eq!(response.status, 202, "{response:?}");
    tokio::time::timeout(Duration::from_secs(30), script.parent_held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    clock(&address, "2026-10-27T22:00:00.000Z").await?;
    script.parent_release.add_permits(1);
    let messages = wait_count(&s, "work_result", 1).await?;
    assert_eq!(messages[0]["quiet"], true);
    assert_eq!(messages[0]["initiated"]["quiet"], true);
    assert!(
        s.gw.events_since(0)
            .await?
            .iter()
            .any(|e| e["payload"]["message"]["id"] == messages[0]["id"]
                && e["payload"]["message"]["quiet"] == true)
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
