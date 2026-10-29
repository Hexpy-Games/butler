//! Schedule ownership caps both resumed and continued child turns.
use super::*;
use std::sync::atomic::Ordering;

async fn next_held(script: &stub::Script) {
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}

async fn decide(s: &Scenario, command: &str, action: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let cards = s.gw.approval_requests("general").await?;
        if cards
            .iter()
            .any(|c| c["approval"]["operation"]["command"] == command)
        {
            return crate::access_tiers::approve(s, "general", action).await;
        }
        assert!(
            Instant::now() < deadline,
            "missing approval for {command}: {cards:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn scheduled_child(resume_mode: &str) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start(false, true).await?;
    script.tier.store(true, Ordering::SeqCst);
    script.resume_probe.store(true, Ordering::SeqCst);
    let (s, _) = setup("SS6-SCHEDULE-TIER", &url).await?;
    assert_eq!(
        s.gw.patch(
            "/sessions/general/controls",
            json!({"access_mode":"ask_first"})
        )
        .await?
        .status,
        200
    );
    let created = s.gw.post("/automations", json!({"title":"Evidence schedule","prompt_body":"Prepare evidence.",
        "target_session_id":"general","schedule_type":"once","run_at":"2099-01-01T00:00:00Z","access_mode":"ask_except_reads"})).await?;
    assert_eq!(created.status, 201, "{created:?}");
    let id = created.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?
            .status,
        202
    );
    next_held(&script).await;
    let (relation, child): (String, String) = runtime(&s)?.query_row(
        "SELECT relation_id,child_session_id FROM btcc_session_relations",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let mode: String = runtime(&s)?.query_row("SELECT json_extract(context_json,'$.executionPolicy.accessMode') FROM btcc_turns WHERE session_id=?1", [&child], |r| r.get(0))?;
    assert_eq!(
        mode, "ask_except_reads",
        "schedule controls own the child, independently of Chats controls"
    );
    assert_eq!(
        s.gw.patch(
            &format!("/automations/{id}"),
            json!({"access_mode":resume_mode})
        )
        .await?
        .status,
        200
    );
    script.release.add_permits(1);
    // The current turn retains its admission until the pending action resumes.
    decide(&s, "printf reviewed", "allow").await?;
    if resume_mode == "ask_first" {
        // This observation would run without approval under the start tier.
        decide(&s, "printf next", "deny").await?;
    }
    wait_count(&s, "work_result", 1).await?;
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    let requests = script.requests.lock().unwrap().clone();
    let refused = requests
        .iter()
        .flat_map(|r| r["input"].as_array().into_iter().flatten())
        .filter(|item| item["type"] == "function_call_output" && item["call_id"] == "tier-next")
        .filter_map(|item| serde_json::from_str::<Value>(item["output"].as_str()?).ok())
        .any(|v| !v.get("output").unwrap_or(&v)["error"].is_null());
    assert!(
        refused,
        "resumed observation must be refused under the current schedule ceiling"
    );
    // A user instruction changes attendance, while the original schedule still
    // owns the child's access ceiling.
    assert_eq!(
        s.gw.patch(
            &format!("/automations/{id}"),
            json!({"access_mode":"read_only"})
        )
        .await?
        .status,
        200
    );
    *script.relation.lock().unwrap() = relation;
    let followup =
        s.gw.say_turn("general", "Check the evidence again.")
            .await?;
    s.gw.wait_terminal("general", &followup, Duration::from_secs(30))
        .await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let modes: Vec<String> = runtime(&s)?.prepare("SELECT json_extract(context_json,'$.executionPolicy.accessMode') FROM btcc_turns WHERE session_id=?1 ORDER BY rowid")?
            .query_map([&child], |r| r.get(0))?.collect::<Result<_, _>>()?;
        if modes.len() >= 2 {
            assert_eq!(modes[1], "read_only");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "continued child did not start\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn schedule_lower_to_ask_first_caps_resumed_and_continued_children()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    scheduled_child("ask_first").await
}

#[tokio::test]
async fn schedule_lower_to_read_only_caps_resumed_and_continued_children()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    scheduled_child("read_only").await
}
