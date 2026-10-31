//! A direction's continuation stays controllable: the parent can steer or stop
//! it, and it reads as the relation's current Work.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::steward_direction_finish::{started, steer};
use super::steward_interrupted_queue::{count, db, request_text};
use super::steward_presentation::{self, stub};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

type Results = Vec<(String, String)>;

fn results(s: &Scenario, relation: &str) -> Results {
    db(s)
        .prepare(
            "SELECT child_turn_id,status FROM btcc_steward_results WHERE relation_id=?1 ORDER BY rowid",
        )
        .unwrap()
        .query_map([relation], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// Waits for `expected` child results, each answered by the parent.
async fn wait_reports(
    s: &Scenario,
    relation: &str,
    expected: usize,
) -> Result<Results, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let saved = results(s, relation);
        let reports =
            s.gw.messages("general")
                .await?
                .iter()
                .filter(|m| m["text"] == "Approach B verified." && m["status"] == "delivered")
                .count();
        if saved.len() == expected && reports == expected {
            return Ok(saved);
        }
        assert!(
            Instant::now() < deadline,
            "results={saved:?} reports={reports}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Holds the child's first report, steers it, and holds its direction's turn
/// at `next`.
async fn hold_continuation(
    id: &str,
    next: &'static str,
    blocked: bool,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
        String,
        String,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start().await?;
    script.release.notify_one();
    script.plan_continuation.store(true, Ordering::SeqCst);
    script.continuation_blocked.store(blocked, Ordering::SeqCst);
    *script.hold_child_item.lock().unwrap() = Some("message");
    let s = started(id, &url, &script).await?;
    held(&s, &script).await;
    let (relation, session, _) = steer(&s, &script).await?;
    *script.hold_child_item.lock().unwrap() = Some(next);
    script.item_release.notify_one();
    held(&s, &script).await;
    Ok((s, script, server, relation, session))
}

async fn held(s: &Scenario, script: &stub::Script) {
    tokio::time::timeout(Duration::from_secs(60), script.item_held.notified())
        .await
        .unwrap_or_else(|_| panic!("child never reached the held round\n{}", s.agent.logs()));
}

fn works(s: &Scenario, session: &str) -> Vec<String> {
    db(s)
        .prepare("SELECT status FROM btcc_guided_works WHERE session_id=?1 ORDER BY rowid")
        .unwrap()
        .query_map([session], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[tokio::test]
async fn next_direction_stays_on_the_work_a_continuation_left_blocked() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server, relation, session) =
        hold_continuation("STEWARD-DIRECTION-BLOCKED", "message", true).await?;
    s.turn("general", stub::DIRECTION_2).await?;
    assert_eq!(
        count(
            &db(&s),
            "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
            &relation
        ),
        1,
        "the running continuation must keep the next direction"
    );
    script.item_release.notify_one();
    let saved = wait_reports(&s, &relation, 3).await?;
    let statuses: Vec<_> = saved.iter().map(|(_, status)| status.as_str()).collect();
    assert_eq!(statuses, ["success", "blocked", "success"]);
    assert_eq!(works(&s, &session), ["completed", "completed"]);
    let second = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|r| {
            let text = request_text(r);
            text.starts_with(stub::DIRECTION_2) && text != stub::DIRECTION_2
        })
        .expect("the second direction opened no turn")
        .to_string();
    // The Work's own original request may still say how that Work began.
    let (_, current) = second
        .rsplit_once("## Current request")
        .expect("the turn states its request");
    assert!(
        !current.contains("runs on a new Work") && current.contains("Continue the existing Work"),
        "the blocked Work is re-bound, not replaced: {current}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn direction_after_a_closed_continuation_is_refused_with_feedback() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server, relation, session) =
        hold_continuation("STEWARD-DIRECTION-CLOSED", "message", false).await?;
    script.item_release.notify_one();
    wait_reports(&s, &relation, 2).await?;
    s.turn("general", stub::DIRECTION_2).await?;
    let refused = script.requests.lock().unwrap().iter().any(|request| {
        request_text(request) == stub::DIRECTION_2
            && request.to_string().contains("delegated_session_closed")
    });
    assert!(refused, "the closed relation must say so");
    assert_eq!(results(&s, &relation).len(), 2, "no child was steered");
    assert_eq!(works(&s, &session), ["completed", "completed"]);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn running_continuation_is_stoppable_and_shows_as_the_current_work()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, relation, session) =
        hold_continuation("STEWARD-DIRECTION-STOP", "direction-close", false).await?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = &view.data()["steward_children"][0];
    assert_eq!(child["status"], "active", "{child}");
    assert_eq!(child["latest_turn"]["cancellable"], true, "{child}");
    let graphs = s.gw.get("/sessions/general/task-graphs").await?;
    let mut shown = false;
    for graph in graphs.data()["graphs"].as_array().unwrap() {
        let id = graph["graph_id"].as_str().unwrap();
        let detail = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
        shown |= detail.text.contains("Compare the direction");
    }
    assert!(shown, "the graph still shows the closed Work: {graphs:?}");
    let stopped =
        s.gw.post(
            &format!("/steward-relations/{relation}/cancel"),
            json!({"parent_session_id":"general"}),
        )
        .await?;
    assert!(
        (200..300).contains(&stopped.status),
        "a running continuation must stop: {stopped:?}"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while results(&s, &relation).len() < 2 {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(results(&s, &relation)[1].1, "cancelled");
    assert_eq!(works(&s, &session), ["completed", "abandoned"]);
    script.item_release.notify_one();
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn read_prior_delegation_mid_turn_keeps_the_packet_context() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    script.release.notify_one();
    script.read_prior_after_close.store(true, Ordering::SeqCst);
    let s = started("STEWARD-PRIOR-MID-TURN", &url, &script).await?;
    steward_presentation::wait_result(&s).await?;
    let output = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .flat_map(|request| request["input"].as_array().unwrap().clone())
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == "read-prior")
        .expect("the closing batch read the prior delegation");
    let output: Value = serde_json::from_str(output["output"].as_str().unwrap())?;
    assert_eq!(
        output["output"]["prior_delegation"],
        Value::Null,
        "a first delegation has no prior one, even once its Work closed: {output}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
