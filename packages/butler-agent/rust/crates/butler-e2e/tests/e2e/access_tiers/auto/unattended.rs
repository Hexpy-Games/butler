//! PERM-03 (D8 beyond Auto): a scheduled run never waits, whatever its asking
//! mode. An `ask_first` schedule fails fast at its first step that asks and
//! flags the run; a steward the run delegates to, and the turn that reads the
//! steward's result, cannot wait either. A full-access schedule is never
//! blocked.
use super::super::stub::{self, Script, call};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const CHECK: &str = "Nightly remote check.";
const READ_ONLY: &str = "Nightly read-only plan.";
const FULL: &str = "Nightly remote check with full access.";
const DELEGATE: &str = "Nightly delegated research.";
const STEWARD: &str = "role: steward";
const RESULT: &str = "Delegated result";

#[tokio::test]
async fn scheduled_runs_never_wait_in_any_mode() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let started = Instant::now();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("PERM-03")?
        .access(Access::Auto)
        .clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    assert_eq!(
        s.gw.patch("/settings", json!({"plan_mode_default":true}))
            .await?
            .status,
        200
    );
    let rounds = [
        (CHECK, vec![network("net")]),
        (FULL, vec![network("full-net")]),
        (
            READ_ONLY,
            vec![call(
                "readonly-restart",
                "request_service_restart",
                &json!({}),
            )],
        ),
        (DELEGATE, delegation()),
        (STEWARD, steward()),
        (RESULT, vec![network("result-net")]),
    ];
    for (prompt, steps) in rounds {
        script.rounds.lock().unwrap().insert(prompt.into(), steps);
    }

    let schedule = create(&s, CHECK, "ask_first").await?;
    let run = scheduled_run(&s, &schedule).await?;
    assert_eq!(run["safe_error_code"], "schedule_permission_required");
    assert!(feedback(&script, "net").contains("schedule_permission_required"));
    eprintln!("PERM-03 ask_first: failed_fast=true run_flagged=true");

    let schedule = create(&s, READ_ONLY, "read_only").await?;
    let run = scheduled_run(&s, &schedule).await?;
    assert_eq!(
        run["safe_error_code"],
        "schedule_permission_required",
        "{}",
        feedback(&script, "readonly-restart")
    );
    assert!(feedback(&script, "readonly-restart").contains("schedule_permission_required"));
    eprintln!("PERM-03 read_only_plan: failed_fast=true run_flagged=true");

    let schedule = create(&s, FULL, "full_access").await?;
    let run = scheduled_run(&s, &schedule).await?;
    assert!(run["safe_error_code"].is_null(), "{run}");
    let output = feedback(&script, "full-net");
    assert!(output.contains("remote-ok"), "{output}");
    eprintln!("PERM-03 full_access: ran=true run_flagged=false");

    let schedule = create(&s, DELEGATE, "auto").await?;
    let run = scheduled_run(&s, &schedule).await?;
    let run_id = run["id"].as_str().unwrap().to_owned();
    let deadline = Instant::now() + Duration::from_secs(30);
    while feedback(&script, "result-net").is_empty() {
        assert!(
            Instant::now() < deadline,
            "the delegated result turn did not finish\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(feedback(&script, "steward-net").contains("schedule_permission_required"));
    assert!(feedback(&script, "result-net").contains("schedule_permission_required"));
    settled(&s).await?;
    assert_eq!(authority_requests(&s)?, 0, "{}", s.agent.logs());
    // The steward's skipped step flags the schedule run that delegated it.
    run_where(&s, &schedule, |run| {
        run["id"] == run_id.as_str() && run["safe_error_code"] == "schedule_permission_required"
    })
    .await?;
    eprintln!(
        "PERM-03 delegated: steward=failed_fast result_turn=failed_fast authority_count=0 elapsed_ms={}",
        started.elapsed().as_millis()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn network(id: &str) -> Value {
    call(
        id,
        "run_command",
        &json!({"command":"echo remote-ok","summary":"Check remote","state_effect":"remote_observation"}),
    )
}

fn plan(mode: &str) -> Value {
    call(
        &format!("plan-{mode}"),
        "replace_work_plan",
        &json!({"objective":DELEGATE,"execution_mode":mode,"checks":["remote checked"],
            "actions":[{"action_key":"research","description":DELEGATE,"dependency_keys":[]}]}),
    )
}

fn review(id: &str) -> Value {
    call(
        id,
        "record_work_review",
        &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
    )
}

/// The scheduled turn plans, reviews and hands the work to a steward.
fn delegation() -> Vec<Value> {
    vec![call(
        "delegate",
        "delegate_to_steward",
        &json!({"request":DELEGATE,"checks":["remote checked"],"safe_title":"Research"}),
    )]
}

/// The steward tries a step its mode asks about, then reports.
fn steward() -> Vec<Value> {
    vec![
        plan("direct"),
        review("steward-review"),
        network("steward-net"),
        call(
            "dispose",
            "record_work_disposition",
            &json!({"work_id":"{{WORK}}","disposition":"completed","summary":"Remote step skipped.",
                "action_updates":[{"action_key":"research","status":"done"}],
                "remaining_actions":[],"followups":[]}),
        ),
    ]
}

async fn create(s: &Scenario, prompt: &str, mode: &str) -> Result<String, HarnessError> {
    let created =
        s.gw.post(
            "/automations",
            json!({"title":prompt, "prompt_body":prompt, "target_session_id":"general",
                "schedule_type":"once", "run_at":"2000-01-01T00:00:00.000Z", "access_mode":mode}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    Ok(created.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}

/// Dispatches the due schedule and waits until its turn was delivered.
async fn scheduled_run(s: &Scenario, schedule: &str) -> Result<Value, HarnessError> {
    let due = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(due.status, 202, "{}", due.text);
    let run = run_where(s, schedule, |run| {
        run["trigger"] == "scheduled" && run["turn_id"].is_string()
    })
    .await?;
    let turn = run["turn_id"].as_str().unwrap();
    let done =
        s.gw.wait_terminal("general", turn, Duration::from_secs(20))
            .await?;
    assert_eq!(done["state"], "delivered", "{done}\n{}", s.agent.logs());
    run_where(s, schedule, |run| run["turn_id"] == turn).await
}

/// The newest output the model received for the call `id`.
fn feedback(script: &Arc<Script>, id: &str) -> String {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .rev()
        .filter_map(|request| request["input"].as_array())
        .flatten()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)
        .and_then(|item| item["output"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Waits until no turn of the target conversation is still running.
async fn settled(s: &Scenario) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let turns = s.gw.turns("general").await?;
        if turns
            .iter()
            .all(|turn| matches!(turn["state"].as_str(), Some("delivered" | "failed")))
        {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "turns still running: {turns:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn authority_requests(s: &Scenario) -> Result<u64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    Ok(
        db.query_row("SELECT count(*) FROM btcc_authority_requests", [], |row| {
            row.get(0)
        })?,
    )
}

pub(super) async fn run_where(
    s: &Scenario,
    schedule: &str,
    matches: impl Fn(&Value) -> bool,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let reply = s.gw.get(&format!("/automations/{schedule}/runs")).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        if let Some(run) = reply.data()["runs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|run| matches(run))
        {
            return Ok(run.clone());
        }
        assert!(
            Instant::now() < deadline,
            "no matching run: {}\n{}",
            reply.text,
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
