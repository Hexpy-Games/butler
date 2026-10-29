//! Admission origin, current controls and isolation of invalid durable results.
use super::*;
use std::sync::atomic::Ordering;

async fn result(s: &Scenario, id: &str, schedule: Option<Value>) -> Result<(), HarnessError> {
    let mut body = json!({"relation_id":id,"result_id":id,"safe_title":"Evidence",
        "child_session_id":format!("child-{id}"),"parent_chat_id":"general",
        "text":"Evidence is ready.","model_ref":s.model.model,"reasoning_effort":s.model.effort.clone().unwrap_or_else(|| "low".into()),
        "access_mode":"full_access"});
    if let Some(schedule) = schedule {
        body["schedule_run"] = schedule;
    }
    let reply = s.gw.post("/internal/subsession-result", body).await?;
    assert_eq!(reply.status, 202, "{reply:?}");
    Ok(())
}

#[tokio::test]
async fn held_user_result_uses_current_read_only_controls_and_denies_mutation()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    script.result_mutation.store(true, Ordering::SeqCst);
    let (s, address) = setup("SS6-HELD-TIER", &url).await?;
    assert_eq!(
        s.gw.post("/sessions/general/composing", json!({}))
            .await?
            .status,
        200
    );
    result(&s, "held-tier", None).await?;
    held(&s, "work_result", 1).await?;
    let payload: String = app(&s)?.query_row(
        "SELECT payload_json FROM app_initiated_messages WHERE kind='work_result'",
        [],
        |r| r.get(0),
    )?;
    assert!(
        serde_json::from_str::<Value>(&payload)?
            .get("access_mode")
            .is_none()
    );
    assert_eq!(
        s.gw.patch(
            "/sessions/general/controls",
            json!({"access_mode":"read_only"})
        )
        .await?
        .status,
        200
    );
    clock(&address, "2026-10-27T12:00:11.000Z").await?;
    wait_count(&s, "work_result", 1).await?;
    let mode: String = app(&s)?.query_row("SELECT json_extract(execution_controls_json,'$.access_mode') FROM turns ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0))?;
    assert_eq!(mode, "read_only");
    assert!(!s.sandbox.data.join("notice.txt").exists());
    assert!(!s.sandbox.workspace.join("notice.txt").exists());
    let requests = script.requests.lock().unwrap().clone();
    let refused = requests
        .iter()
        .flat_map(stub::outputs)
        .find(|v| !v["error"].is_null())
        .expect("mutating tool was denied");
    assert_eq!(refused["error"]["code"], "tool_unavailable", "{refused}");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn bad_held_results_fail_without_blocking_a_good_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    let (s, address) = setup("SS6-OUTBOX-FAILURE", &url).await?;
    assert_eq!(
        s.gw.post("/sessions/general/composing", json!({}))
            .await?
            .status,
        200
    );
    result(&s, "bad-model", None).await?;
    app(&s)?.execute("UPDATE app_initiated_messages SET payload_json=json_set(payload_json,'$.model','missing/model') WHERE source_key='work-result:bad-model:bad-model'", [])?;
    app(&s)?.execute("INSERT INTO app_initiated_messages(id,chat_id,kind,source_key,text,payload_json,bypass_quiet_hours,state,created_at) VALUES('invalid-payload','general','work_result','invalid-payload','Evidence','{',1,'held','2026-10-27T12:00:00.000Z')", [])?;
    result(&s, "good", None).await?;
    held(&s, "work_result", 3).await?;
    clock(&address, "2026-10-27T12:00:11.000Z").await?;
    let messages = wait_count(&s, "work_result", 2).await?;
    let mut relations: Vec<_> = messages
        .iter()
        .map(|m| m["initiated"]["relation_id"].as_str().unwrap())
        .collect();
    relations.sort_unstable();
    assert_eq!(relations, ["bad-model", "good"]);
    wait_count(&s, "work_failed", 1).await?;
    let failed: i64 = app(&s)?.query_row("SELECT count(*) FROM app_initiated_messages WHERE state='failed' AND reason IS NOT NULL AND length(reason)>0", [], |r| r.get(0))?;
    assert_eq!(failed, 1);
    held(&s, "work_result", 0).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn scheduled_result_holds_through_quiet_restart_and_uses_current_schedule_tier()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false, true).await?;
    script.delegated.store(true, Ordering::SeqCst);
    let (mut s, address) = setup("SS6-SCHEDULE-RESULT", &url).await?;
    let created = s.gw.post("/automations", json!({"title":"Evidence schedule","prompt_body":"Check evidence.","target_session_id":"general",
        "schedule_type":"once","run_at":"2099-01-01T00:00:00Z","access_mode":"full_access"})).await?;
    assert_eq!(created.status, 201, "{created:?}");
    let id = created.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    clock(&address, "2026-10-28T06:59:59.000Z").await?;
    result(
        &s,
        "scheduled",
        Some(json!({"automation_id":id,"run_id":"scheduled-run","unattended":true})),
    )
    .await?;
    held(&s, "work_result", 1).await?;
    assert_eq!(s.gw.messages("general").await?, [] as [Value; 0]);
    s.agent
        .launch
        .set_env("BUTLER_E2E_APP_NOW", "2026-10-28T06:59:59.000Z");
    s.crash_and_restart().await?;
    held(&s, "work_result", 1).await?;
    assert_eq!(s.gw.messages("general").await?, [] as [Value; 0]);
    assert_eq!(
        s.gw.patch(
            &format!("/automations/{id}"),
            json!({"access_mode":"read_only"})
        )
        .await?
        .status,
        200
    );
    clock(&address, "2026-10-28T12:00:00.000Z").await?;
    let messages = wait_count(&s, "work_result", 1).await?;
    assert_eq!(messages[0]["initiated"]["quiet"], false);
    let mode: String = app(&s)?.query_row("SELECT json_extract(execution_controls_json,'$.access_mode') FROM turns ORDER BY rowid DESC LIMIT 1", [], |r| r.get(0))?;
    assert_eq!(mode, "read_only");
    s.finish().await?;
    server.abort();
    Ok(())
}
