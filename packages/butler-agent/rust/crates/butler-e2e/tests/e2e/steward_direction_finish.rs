//! A direction sent as the child finishes runs in a turn that can act on it,
//! and a stopped child never takes one up again.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::steward_interrupted_queue::{count, db, records, request_text};
use super::steward_presentation::{self, stub};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::json;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

fn close(work: &str) -> serde_json::Value {
    stub::call(
        "direction-close",
        "record_work_disposition",
        &json!({"work_id":work,"disposition":"completed","summary":"Direction applied","action_updates":[{"action_key":"read","status":"done"},{"action_key":"compare","status":"done"}],"remaining_actions":[],"followups":[]}),
    )
}

/// A direction's own turn plans, changes a file and closes its fresh Work. A
/// second direction's turn only closes the Work the first one left blocked.
pub(super) fn continuation_item(
    script: &stub::Script,
    request: &str,
    body: &serde_json::Value,
) -> serde_json::Value {
    if request.starts_with(stub::DIRECTION_2) {
        let work = script.continuation_work.lock().unwrap().clone();
        return match script.second_direction_step.fetch_add(1, Ordering::SeqCst) {
            0 => close(&work),
            _ => stub::message("Second direction applied."),
        };
    }
    match script.continuation_step.fetch_add(1, Ordering::SeqCst) {
        0 => stub::call(
            "direction-plan",
            "replace_work_plan",
            &stub::plan(false, "direct"),
        ),
        1 => stub::call("direction-review", "record_work_review", &stub::review()),
        2 => stub::call(
            "direction-write",
            "write_file",
            &json!({"path":"direction.html","content":"<!doctype html>\n<title>Direction</title>\n"}),
        ),
        3 => stub::call(
            "direction-checkpoint",
            "record_work_checkpoint",
            &json!({"public_summary":"Applying the direction","next_step":"Compare the direction","action_updates":[{"action_key":"read","status":"done"},{"action_key":"compare","status":"active"}]}),
        ),
        4 => {
            let work = stub::work_id(body);
            work.clone_into(&mut script.continuation_work.lock().unwrap());
            if script.continuation_blocked.load(Ordering::SeqCst) {
                return stub::call(
                    "direction-blocked",
                    "record_work_disposition",
                    &json!({"work_id":work,"disposition":"blocked","summary":"Direction needs follow-up","action_updates":[],"remaining_actions":["compare"],"next_condition":"Owner follow-up","followups":[]}),
                );
            }
            close(&work)
        }
        _ => stub::message("Direction applied."),
    }
}

pub(super) async fn started(
    id: &str,
    url: &str,
    script: &stub::Script,
) -> Result<Scenario, HarnessError> {
    let setup = steward_presentation::setup(id, url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", stub::OWNER).await?;
    Ok(s)
}

/// Steers the only child and returns its relation, session and first turn.
pub(super) async fn steer(
    s: &Scenario,
    script: &stub::Script,
) -> Result<(String, String, String), HarnessError> {
    let view = s.gw.get("/session-view?session_id=general").await?;
    let child = &view.data()["steward_children"][0];
    let relation = child["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let session = child["session_id"].as_str().unwrap().to_owned();
    let first: String = db(s).query_row(
        "SELECT child_turn_id FROM btcc_subsession_delegations WHERE relation_id=?1",
        [&relation],
        |row| row.get(0),
    )?;
    *script.relation.lock().unwrap() = relation.clone();
    s.turn("general", stub::DIRECTION).await?;
    assert_eq!(
        count(
            &db(s),
            "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
            &relation
        ),
        1,
        "the running child has not taken the direction yet"
    );
    Ok((relation, session, first))
}

async fn direction_near_the_end(id: &str, held: &'static str) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start().await?;
    script.release.notify_one();
    script.plan_continuation.store(true, Ordering::SeqCst);
    *script.hold_child_item.lock().unwrap() = Some(held);
    let s = started(id, &url, &script).await?;
    tokio::time::timeout(Duration::from_secs(30), script.item_held.notified())
        .await
        .unwrap_or_else(|_| panic!("child never reached {held}\n{}", s.agent.logs()));
    let (relation, session, first) = steer(&s, &script).await?;
    script.item_release.notify_one();
    let continuation = applied_with_result(&s, &relation).await?;
    assert_ne!(
        continuation, first,
        "the settled turn swallowed the direction"
    );
    let database = db(&s);
    let statuses: Vec<(String, String)> = database
        .prepare(
            "SELECT child_turn_id,status FROM btcc_steward_results WHERE relation_id=?1 ORDER BY rowid",
        )?
        .query_map([&relation], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    assert_eq!(
        statuses,
        [
            (first, "success".to_owned()),
            (continuation, "success".to_owned())
        ]
    );
    let works: i64 = database.query_row(
        "SELECT count(*) FROM btcc_guided_works WHERE session_id=?1 AND status='completed'",
        [&session],
        |row| row.get(0),
    )?;
    assert_eq!(works, 2, "a completed Work is never reopened");
    {
        let requests = script.requests.lock().unwrap();
        let opening = requests
            .iter()
            .find(|r| {
                let text = request_text(r);
                text.starts_with(stub::DIRECTION) && text != stub::DIRECTION
            })
            .expect("the direction never opened its own child turn");
        assert!(
            opening.to_string().contains("Approach B verified"),
            "the direction's turn lost what the child already did: {opening}"
        );
        let opening = opening.to_string();
        assert!(
            opening.contains("has no Plan yet") && !opening.contains("retained checkpoint"),
            "a fresh Work has no checkpoint to continue: {opening}"
        );
        let written = requests
            .iter()
            .flat_map(|request| request["input"].as_array().unwrap())
            .find(|item| {
                item["type"] == "function_call_output" && item["call_id"] == "direction-write"
            })
            .expect("the continuation wrote nothing");
        let output: serde_json::Value =
            serde_json::from_str(written["output"].as_str().unwrap()).unwrap();
        assert_eq!(output["ok"], true, "its tools stayed closed: {written}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The direction's settling turn, once its result reached the parent.
async fn applied_with_result(s: &Scenario, relation: &str) -> Result<String, HarnessError> {
    use rusqlite::OptionalExtension;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let settled: Option<String> = db(s)
            .query_row(
                "SELECT d.applied_child_turn_id FROM btcc_subsession_directions d \
                 JOIN btcc_steward_results r ON r.child_turn_id=d.applied_child_turn_id \
                 WHERE d.relation_id=?1 AND d.status='applied'",
                [relation],
                |row| row.get(0),
            )
            .optional()?;
        let reports =
            s.gw.messages("general")
                .await?
                .iter()
                .filter(|m| m["text"] == "Approach B verified." && m["status"] == "delivered")
                .count();
        if let Some(turn) = settled
            && reports == 2
        {
            return Ok(turn);
        }
        assert!(
            Instant::now() < deadline,
            "direction not settled by a delivered result: reports={reports}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn direction_during_the_closing_round_opens_its_own_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    direction_near_the_end("STEWARD-DIRECTION-CLOSING", "record_work_disposition").await
}

#[tokio::test]
async fn direction_during_the_final_report_opens_its_own_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    direction_near_the_end("STEWARD-DIRECTION-REPORT", "message").await
}

#[tokio::test]
async fn direction_to_a_waiting_steward_arrives_with_its_workers_result() -> Result<(), HarnessError>
{
    use rusqlite::OptionalExtension;
    butler_e2e::gate!();
    let (s, script, server) = super::worker_cap::setup("STEWARD-DIRECTION-WAIT", 1).await?;
    s.turn("general", "Verify batch red").await?;
    let (steward, _) = super::worker_cap::workers(&s, "general", 1).await?;
    super::worker_cap::started(&script, 1).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let waiting: Option<String> = db(&s)
            .query_row(
                "SELECT suspension_reason FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
                [&steward],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if waiting.as_deref() == Some("waiting_for_worker") {
            break;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let view = s.gw.get("/session-view?session_id=general").await?;
    let relation = view.data()["steward_children"][0]["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let spec = json!({"name":"steer_steward","arguments":{"relation_id":relation,"instruction":"Check the second source too"}});
    s.turn("general", &format!("fixture-call:{spec}")).await?;
    assert_eq!(
        count(
            &db(&s),
            "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
            &relation
        ),
        1,
        "the waiting steward keeps the direction for its next round"
    );
    script.release("red-0");
    let deadline = Instant::now() + Duration::from_secs(60);
    let turn = loop {
        let applied: Option<String> = db(&s)
            .query_row(
                "SELECT applied_child_turn_id FROM btcc_subsession_directions WHERE relation_id=?1 AND status='applied'",
                [&relation],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(turn) = applied {
            break turn;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert!(turn.starts_with("worker-result-turn-"), "{turn}");
    // The direction is claimed just before the round that carries it.
    while !script.requests.lock().unwrap().iter().any(|(role, body)| {
        let body = body.to_string();
        role == "steward"
            && body.contains("Parent direction update")
            && body.contains("Check the second source too")
    }) {
        assert!(
            Instant::now() < deadline,
            "the steward's next round never saw the direction\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn stopped_child_does_not_take_up_its_direction_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let mut s = started("STEWARD-DIRECTION-STOPPED", &url, &script).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .unwrap();
    let (relation, session, _) = steer(&s, &script).await?;
    s.gw.post(
        &format!("/steward-relations/{relation}/cancel"),
        json!({"parent_session_id":"general"}),
    )
    .await?;
    let results = "SELECT count(*) FROM btcc_steward_results WHERE relation_id=?1";
    let deadline = Instant::now() + Duration::from_secs(30);
    while count(&db(&s), results, &relation) == 0 {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    script.release.notify_one();
    s.restart().await?;
    let root = s.sandbox.data.join("runtime/inbound-events");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !records(&root, "pending").is_empty() || !records(&root, "processing").is_empty() {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let database = db(&s);
    assert_eq!(
        count(
            &database,
            "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
            &relation
        ),
        0,
        "the stop retired the direction"
    );
    assert_eq!(
        count(&database, results, &relation),
        1,
        "the stopped child ran again"
    );
    let view =
        s.gw.get(&format!("/session-view?session_id={session}"))
            .await?;
    assert_eq!(view.data()["status"], "cancelled", "{view:?}");
    s.finish().await?;
    server.abort();
    Ok(())
}
