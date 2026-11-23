//! Public gateway/provider handoffs: scope, replacement and confirmed inputs.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::fmt::Write;
use std::time::{Duration, Instant};

const USER: &str = "조사해서 정리해줘.\n  원문과 공백을 그대로 보존해 주세요. 🦋";
const READING: &str = "Research and summarize as a styled HTML page";
const FACTS: &str = "Confirmed: the measured capacity is 42 units.\nopen gaps: the replacement date remains unknown.";
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Verbatim,
    Replace,
    Facts,
    Scope,
}

#[tokio::test]
async fn handoff_carries_verbatim_user_words_to_steward_and_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Verbatim).await?;
    let requests = script.requests.lock().unwrap().clone();
    for (role, label) in [
        ("steward", "user_request (the user's own words, verbatim): "),
        (
            "worker",
            "user_request (the user's own words, verbatim; context only, your assignment below is your scope): ",
        ),
    ] {
        let body = requests
            .iter()
            .find(|(r, _)| r == role)
            .unwrap()
            .1
            .to_string();
        let decoded = body.replace("\\n", "\n");
        assert!(decoded.contains(&format!("{label}{USER}")), "{body}");
        if role == "steward" {
            assert!(decoded.contains(&format!("request (Butler's reading): {READING}")));
        }
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn child_turns_are_not_offered_start_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Verbatim).await?;
    let requests = script.requests.lock().unwrap().clone();
    let offered = |role: &str| {
        requests.iter().filter(|(r, _)| r == role).any(|(_, body)| {
            butler_e2e::e2e::chatgpt_wire::functions(body).any(|tool| tool["name"] == "start_work")
        })
    };
    assert!(offered("butler"), "an unbound Butler turn may start Work");
    assert!(
        !offered("steward") && !offered("worker"),
        "child turns start bound to their Work"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn replacement_stops_old_worker_and_marks_its_late_cancellation_as_evidence()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Replace).await?;
    let requests = script.requests.lock().unwrap().clone();
    let db = db(&s)?;
    let (old, new): (String, String) = db.query_row("SELECT relation_id,json_extract(packet_json,'$.superseded_by') FROM btcc_subsession_delegations WHERE json_extract(packet_json,'$.superseded_by') IS NOT NULL", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let prefix = format!(
        "Superseded Worker result: {old} was replaced by {new} for action A; it is not this action's result."
    );
    assert!(
        requests
            .iter()
            .any(|(r, b)| r == "steward" && b.to_string().contains(&prefix))
    );
    assert!(
        script
            .replacement_settled
            .load(std::sync::atomic::Ordering::SeqCst),
        "replacement provider input must follow old result settlement"
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["steward_children"][0]["approved_plan_total"], 1);
    assert_eq!(
        view.data()["steward_children"][0]["approved_plan_completed"],
        1
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn next_task_receives_confirmed_inputs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Facts).await?;
    let requests = script.requests.lock().unwrap().clone();
    let a: String = db(&s)?.query_row(
        "SELECT task_id FROM btcc_work_tasks WHERE action_key='A'",
        [],
        |r| r.get(0),
    )?;
    let next = requests
        .iter()
        .find(|(r, b)| r == "worker" && b.to_string().contains("assigned_objective: next step"))
        .unwrap()
        .1
        .to_string();
    assert!(
        next.contains(&format!(
            "inputs (confirmed, do not re-check): {a} evidence:"
        )),
        "{next}"
    );
    assert!(
        next.contains("Confirmed: the measured capacity is 42 units. open gaps: the replacement date remains unknown."),
        "{next}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn db(s: &Scenario) -> Result<rusqlite::Connection, HarnessError> {
    Ok(rusqlite::Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}
async fn run(
    mode: Mode,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(mode).await?;
    let s = Setup::new("DELEGATION-HANDOFF")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", &url)
        .start()
        .await?;
    let chat: String = "general".into();
    *script.data.lock().unwrap() = s.sandbox.data.clone();
    s.turn(&chat, USER).await?;
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let settled: bool = db(&s)?.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations d JOIN btcc_steward_results x USING(relation_id) JOIN btcc_subsession_outbox o USING(result_id) WHERE json_extract(d.packet_json,'$.child_role')='steward' AND x.status='success' AND o.status='delivered')", [], |r| r.get(0))?;
        if settled {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "stage={} first_errors={:?} last_outputs={:?}",
            script.stage.load(std::sync::atomic::Ordering::SeqCst),
            script
                .requests
                .lock()
                .unwrap()
                .iter()
                .flat_map(|(_, b)| stub::outputs(b))
                .filter(|v| v["ok"] == false)
                .take(4)
                .collect::<Vec<_>>(),
            script
                .requests
                .lock()
                .unwrap()
                .last()
                .map(|(_, body)| stub::outputs(body)
                    .into_iter()
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>())
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok((s, script, server))
}

pub(super) async fn scope_writes() -> Result<(), HarnessError> {
    let (s, script, server) = run(Mode::Scope).await?;
    let requests = script.requests.lock().unwrap().clone();
    let outputs: Vec<Value> = requests
        .iter()
        .filter(|(role, _)| role == "worker")
        .flat_map(|(_, b)| stub::outputs(b))
        .collect();
    assert!(
        outputs.iter().any(|o| o
            .to_string()
            .contains("outside the files this task may change")),
        "{outputs:?}"
    );
    assert!(
        outputs.iter().any(|o| o["task_scope_errors"]
            .as_array()
            .is_some_and(|e| !e.is_empty())),
        "{outputs:?}"
    );
    assert!(
        outputs
            .iter()
            .any(|o| o["ok"] == true && o["path"] == "tasks/A/inside.txt"),
        "{outputs:?}"
    );
    assert_eq!(
        std::fs::read_to_string(s.sandbox.data.join("artifacts/generated/outside.txt"))?,
        "scope-change",
        "command changes must be reported without rollback"
    );
    assert!(
        outputs.iter().any(|o| o["task_scope_errors"]
            .to_string()
            .contains("outside-command.txt")),
        "{outputs:?}"
    );
    let db = db(&s)?;
    let summary:String=db.query_row("SELECT summary FROM btcc_steward_results WHERE relation_id IN (SELECT relation_id FROM btcc_session_relations WHERE activity_role='worker') LIMIT 1",[],|r|r.get(0))?;
    assert!(summary.contains("error: task_scope_write"), "{summary}");
    assert!(
        !summary.contains("/metrics/"),
        "Runtime metrics are not command writes: {summary}"
    );
    assert!(
        !summary.contains("/transcripts/"),
        "Runtime transcripts are not command writes: {summary}"
    );
    assert!(
        requests
            .iter()
            .any(|(r, b)| r == "steward" && b.to_string().contains("error: task_scope_write"))
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
