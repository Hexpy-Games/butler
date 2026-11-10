//! Plan steps, explicit activity correlation and prior-turn history through session-view.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod stub;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[tokio::test]
async fn accepted_plan_steps_and_activity_survive_a_fresh_child_snapshot()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = super::steward_presentation::setup("STEWARD-PLAN-STEPS", &url)?;
    std::fs::write(setup.sandbox.data.join("sources.txt"), "Source material")?;
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(30), script.planned.notified())
        .await
        .unwrap();
    let parent = s.gw.get("/session-view?session_id=general").await?;
    let child = &parent.data()["steward_children"][0];
    assert!(child.get("plan").is_none(), "unaccepted plan: {child}");
    let session = child["session_id"].as_str().unwrap().to_owned();
    *script.relation.lock().unwrap() = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    script.accept.notify_one();
    let first = wait_result(&s, &script, &session, "blocked").await?;
    let first_turn = first["latest_turn"]["id"].as_str().unwrap().to_owned();
    assert_eq!(first["plan"]["actions"].as_array().unwrap().len(), 3);
    assert_eq!(first["approved_plan_total"], 3);
    assert_eq!(first["approved_plan_completed"], 1);
    assert_rows(
        &first["activity_rows"],
        &[("begin-collection", 0), ("begin-comparison", 1)],
        &[stub::KEYS[0], stub::KEYS[1]],
    );
    s.turn("general", stub::DIRECTION).await?;
    tokio::time::timeout(Duration::from_secs(30), script.planned.notified())
        .await
        .unwrap();
    let revision =
        s.gw.get(&format!("/session-view?session_id={session}"))
            .await?;
    assert!(
        revision.data().get("plan").is_none(),
        "revision needs acceptance: {revision:?}"
    );
    script.accept.notify_one();
    let second = wait_result(&s, &script, &session, "blocked").await?;
    assert_rows(
        &second["activity_rows"],
        &[("begin-verification", 3), ("verification-paused", 2)],
        &[stub::KEYS[3]],
    );
    assert_continuation(
        &second["activity_rows"],
        "Comparison saved; summary needs follow-up",
        stub::KEYS[2],
    );
    s.turn("general", stub::FINISH).await?;
    wait_result(&s, &script, &session, "completed").await?;
    let started = Instant::now();
    let fresh =
        s.gw.get(&format!("/session-view?session_id={session}"))
            .await?;
    let elapsed = started.elapsed();
    let view = fresh.data();
    assert_plan(&view["plan"]);
    assert_eq!(view["approved_plan_revision"], 2);
    assert_eq!(view["approved_plan_total"], 4);
    assert_eq!(view["approved_plan_completed"], 4);
    assert_rows(
        &view["activity_rows"],
        &[("verification-resumed", 3), ("all-done", 3)],
        &[],
    );
    assert_continuation(
        &view["activity_rows"],
        "Verification needs follow-up",
        stub::KEYS[3],
    );
    let history = view["activity_history"].as_array().unwrap();
    assert_eq!(history.len(), 2, "{view}");
    assert_eq!(history[0]["turn_id"], first_turn);
    assert!(history.iter().all(|turn| {
        turn["created_at"]
            .as_str()
            .and_then(butler_core::js_date::parse_iso_millis)
            .is_some()
    }));
    assert_eq!(history[0]["rows"], first["activity_rows"]);
    assert_eq!(history[1]["turn_id"], second["latest_turn"]["id"]);
    assert_eq!(history[1]["rows"], second["activity_rows"]);
    assert_ne!(view["latest_turn"]["id"], first_turn);
    assert_errors(&script);
    assert_terminal_time(&s, &session, &view["plan"])?;
    assert_window(&s, &session, &first, &second).await?;
    let parent = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(parent.data()["steward_children"][0]["plan"], view["plan"]);
    butler_e2e::assert_wall_clock_budget!(
        elapsed,
        Duration::from_millis(500),
        "complete child session-view"
    );
    println!(
        "complete child session-view: {} ms; contract={}",
        elapsed.as_millis(),
        json!({"plan":view["plan"],"activity_rows":view["activity_rows"],"activity_history":history})
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_plan(plan: &Value) {
    assert_eq!(plan["revision"], 2);
    let actions = plan["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 4);
    for (i, action) in actions.iter().enumerate() {
        assert_eq!(action["action_key"], stub::KEYS[i]);
        assert_eq!(action["title"], stub::KEYS[i]);
        assert_eq!(action["order"], i + 1);
        assert_eq!(action["purpose"], stub::PURPOSES[i]);
        assert_eq!(action["status"], "done");
        assert_eq!(action["added_in_revision"], if i == 3 { 2 } else { 1 });
        let started = action["started_at"].as_str().unwrap();
        let finished = action["finished_at"].as_str().unwrap();
        assert!(butler_core::js_date::parse_iso_millis(started).is_some());
        assert!(butler_core::js_date::parse_iso_millis(finished).is_some());
        assert!(started <= finished, "{action}");
    }
    let revisions = plan["revisions"].as_array().unwrap();
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0]["revision"], 2);
    assert_eq!(revisions[0]["added"], json!([stub::KEYS[3]]));
    assert_eq!(revisions[0]["removed"], json!([]));
    assert!(revisions[0].get("reason").is_none());
    assert!(revisions[0]["at"].is_string());
}

fn assert_rows(rows: &Value, expected: &[(&str, usize)], tool_keys: &[&str]) {
    let rows = rows.as_array().unwrap();
    let authored = rows
        .iter()
        .filter(|r| r["work_decision_source"] == "model-authored")
        .collect::<Vec<_>>();
    assert!(!authored.is_empty(), "{rows:?}");
    for &(summary, index) in expected {
        let row = authored
            .iter()
            .find(|r| r["work_decision_summary"] == summary)
            .unwrap_or_else(|| panic!("missing {summary}: {rows:?}"));
        assert_eq!(row["action_key"], stub::KEYS[index], "{row}");
    }
    let mut seen = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if row["safe_tool_name"] == "read_file" {
            let preceding = rows[..index]
                .iter()
                .rev()
                .find(|r| r["work_decision_source"] == "model-authored")
                .unwrap();
            let key = preceding["action_key"].as_str().unwrap();
            if seen.last().copied() != Some(key) {
                seen.push(key);
            }
        }
    }
    assert_eq!(
        seen.as_slice(),
        tool_keys,
        "tool groups follow explicit checkpoints: {rows:?}"
    );
    for row in authored {
        assert!(row["created_at"].is_string(), "{row}");
        if matches!(
            row["activity_stage"].as_str(),
            Some("conception" | "planning")
        ) {
            assert!(row.get("action_key").is_none_or(Value::is_null), "{row}");
        }
    }
}

fn assert_errors(script: &stub::Script) {
    let requests = script.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .flat_map(|r| r["input"].as_array().unwrap())
            .any(|item| {
                item["call_id"] == "select-summary"
                    && item["output"]
                        .as_str()
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                        .is_some_and(|result| result["output"]["ok"] == true)
            }),
        "a checkpoint can select an action without a status update"
    );
    for call in ["bad-checkpoint", "bad-continuation"] {
        let outputs = requests
            .iter()
            .flat_map(|r| r["input"].as_array().unwrap())
            .filter(|i| i["type"] == "function_call_output" && i["call_id"] == call)
            .filter_map(|i| i["output"].as_str())
            .collect::<Vec<_>>();
        assert!(
            outputs
                .iter()
                .any(|o| o.contains("not in the current Plan")),
            "{call}: {outputs:?}"
        );
    }
}

async fn assert_window(
    s: &Scenario,
    session: &str,
    view: &Value,
    second: &Value,
) -> Result<(), HarnessError> {
    let token = view["message_window"]["next_cursor_token"]
        .as_str()
        .unwrap();
    let page =
        s.gw.get(&format!(
            "/session-view?session_id={session}&cursor_token={token}"
        ))
        .await?;
    assert_ne!(
        page.data()["messages"].as_array().unwrap().as_slice(),
        &[] as &[Value]
    );
    assert_eq!(
        page.data()["activity_history"].as_array().unwrap().len(),
        1,
        "forward window: {page:?}"
    );
    assert_eq!(
        page.data()["activity_history"][0]["turn_id"],
        second["latest_turn"]["id"]
    );
    let token = second["message_window"]["next_cursor_token"]
        .as_str()
        .unwrap();
    let latest =
        s.gw.get(&format!(
            "/session-view?session_id={session}&cursor_token={token}"
        ))
        .await?;
    assert_eq!(latest.data()["activity_history"], json!([]));
    Ok(())
}

async fn wait_result(
    s: &Scenario,
    script: &stub::Script,
    session: &str,
    status: &str,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let app_status = "delivered";
    let result_status = if status == "completed" {
        "success"
    } else {
        status
    };
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={session}"))
                .await?;
        if view.data()["status"] == app_status && view.data()["latest_turn"]["state"] == "delivered"
        {
            let parent = s.gw.get("/session-view?session_id=general").await?;
            if parent.data()["steward_children"][0]["result"]["child_turn_id"]
                == view.data()["latest_turn"]["id"]
            {
                assert_eq!(
                    parent.data()["steward_children"][0]["result"]["status"],
                    result_status
                );
                return Ok(view.data().clone());
            }
        }
        assert!(
            Instant::now() < deadline,
            "{view:?}\ntool failures: {}",
            tool_failures(script)
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[tokio::test]
async fn worker_projection_keeps_explicit_action_and_call_identity() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = super::worker_cap::setup("WORKER-STEP-IDENTITY", 1).await?;
    s.turn("general", "Verify batch red").await?;
    let (_, workers) = super::worker_cap::workers(&s, "general", 1).await?;
    for worker in &workers {
        assert_eq!(worker["action_key"], "check-0");
        assert!(
            worker["action_key"].as_str().is_some_and(|s| !s.is_empty()),
            "{worker}"
        );
        assert!(
            worker["source_tool_call_id"]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
            "{worker}"
        );
        assert_eq!(
            worker["parent_turn_id"],
            worker["relation"]["parent_turn_id"]
        );
    }
    script.release("red-0");
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_terminal_time(s: &Scenario, session: &str, plan: &Value) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let terminal: String = db.query_row(
        "SELECT c.created_at FROM btcc_guided_work_checkpoint_revisions c JOIN btcc_guided_works w USING(work_id) WHERE w.session_id=?1 AND c.public_summary='all-done' ORDER BY c.revision DESC LIMIT 1",
        [session], |r| r.get(0))?;
    assert_eq!(
        plan["actions"][3]["finished_at"], terminal,
        "terminal timestamp resets after reactivation"
    );
    Ok(())
}

fn assert_continuation(rows: &Value, summary: &str, key: &str) {
    assert!(
        rows.as_array()
            .unwrap()
            .iter()
            .any(|row| row["work_decision_source"] == "model-authored"
                && row["work_decision_summary"] == summary
                && row["action_key"] == key),
        "explicit continuation: {rows}"
    );
}

fn tool_failures(script: &stub::Script) -> Value {
    let requests = script.requests.lock().unwrap();
    json!(
        requests
            .iter()
            .flat_map(|r| r["input"].as_array().unwrap())
            .filter_map(|item| {
                let result: Value = serde_json::from_str(item["output"].as_str()?).ok()?;
                (result["output"]["ok"] == false)
                    .then(|| json!({"call_id":item["call_id"],"result":result}))
            })
            .collect::<Vec<_>>()
    )
}
