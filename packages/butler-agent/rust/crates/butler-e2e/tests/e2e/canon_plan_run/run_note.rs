//! The plan run note, as the provider receives it: present only with a run, current
//! after every change, and never fetched by a tool.
use super::holds::wait_state;
use super::*;
use butler_e2e::e2e::scenario::Scenario;
use serde_json::Value;
use std::sync::atomic::Ordering;

const NOTE: &str = "## Plan run in this conversation";
const UPDATED: &str = "Updated plan run; it changed since the last note.";

fn requests(script: &crate::canon_link::stub::Script) -> Vec<String> {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(ToString::to_string)
        .collect()
}

/// The provider request text of the step Turn for `epic`, from its last round.
fn step_request(script: &crate::canon_link::stub::Script, epic: &str) -> String {
    let marker = format!("This Turn processes canon:epic/{epic}");
    requests(script)
        .into_iter()
        .rev()
        .find(|body| body.contains(&marker))
        .unwrap_or_else(|| panic!("no request for {epic}"))
}

/// Where each epic appears in the note's step list.
fn step_of(body: &str, epic: &str) -> usize {
    let note = &body[body.rfind(NOTE).expect("note")..];
    let at = note
        .find(&format!("canon:epic/{epic}:"))
        .unwrap_or_else(|| panic!("{epic} missing from the note"));
    note[..at].matches("Step ").count()
}

async fn run_plan(s: &Scenario, chat: &str, plan: &str) -> Result<(), HarnessError> {
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    Ok(())
}

async fn edit(s: &Scenario, chat: &str, mut input: Value) -> Result<Value, HarnessError> {
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    input["expected_graph_revision"] = view["graph_revision"].clone();
    Ok(data(
        s.gw.post(&format!("/sessions/{chat}/canon/queue/edits"), input)
            .await?,
        200,
    ))
}

#[tokio::test]
async fn no_run_means_no_note() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, _, chat) =
        crate::canon_link::setup("CB-NOTE-NONE", false, false).await?;
    script.quick.store(true, Ordering::SeqCst);
    s.turn(&chat, "What does this mean?").await?;
    let bodies = requests(&script);
    assert_ne!(bodies.len(), 0);
    assert!(bodies.iter().all(|body| !body.contains(NOTE)));
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The order, its states and the step's place arrive with the step Turn. Titles stay
/// in the envelope; an earlier step's closing summary comes with it.
#[tokio::test]
async fn step_turn_carries_the_whole_run() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-RUN", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.release();
    run_plan(&s, &chat, &plan).await?;
    wait_done(&s, &chat, 3).await?;
    let body = step_request(&script, &epics[1]);
    assert!(body.contains("step 2 of 3"), "{body}");
    assert_eq!(
        (
            step_of(&body, &epics[0]),
            step_of(&body, &epics[1]),
            step_of(&body, &epics[2])
        ),
        (1, 2, 3)
    );
    assert!(body.contains(&format!("canon:epic/{}: done", epics[0])));
    assert!(body.contains(&format!("canon:epic/{}: running (this Turn)", epics[1])));
    assert!(body.contains(&format!("canon:epic/{}: waiting", epics[2])));
    let envelope = &body[body.find("untrusted_content").expect("envelope")..];
    assert!(envelope.contains("Release checks") && envelope.contains("Evidence verified"));
    assert!(!body[..body.find("untrusted_content").unwrap()].contains("Release notes"));
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A reorder by the owner mid-step reaches the model by its next round, unasked.
#[tokio::test]
async fn reorder_mid_step_reaches_the_next_round_without_a_tool_call() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-REORDER", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    edit(
        &s,
        &chat,
        json!({"op":"move_to_new_step","epic_id":epics[2],"index":1}),
    )
    .await?;
    let before = requests(&script).len();
    script.release();
    wait_done(&s, &chat, 3).await?;
    let after = requests(&script);
    let updated = after[before..]
        .iter()
        .find(|body| body.contains(UPDATED))
        .expect("the next round carries the changed run");
    let note = &updated[updated.rfind(UPDATED).unwrap()..];
    assert!(
        note.find(&format!("canon:epic/{}:", epics[2])).unwrap()
            < note.find(&format!("canon:epic/{}:", epics[1])).unwrap(),
        "{note}"
    );
    assert!(
        after
            .iter()
            .all(|body| !body.contains("\"name\":\"canon_read\"")
                || !body.contains("\"view\":\"queue\"")),
        "no tool read the order"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A 묶음 and a hold read as they are.
#[tokio::test]
async fn stack_and_hold_read_as_they_are() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-STACK", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.blocked.lock().unwrap().push(epics[0].clone());
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    edit(
        &s,
        &chat,
        json!({"op":"join_stack","epic_id":epics[2],"target_epic_id":epics[1]}),
    )
    .await?;
    script.release();
    wait_state(&s, &chat, &epics[1], "held").await?;
    script.quick.store(true, Ordering::SeqCst);
    let before = requests(&script).len();
    s.turn(&chat, "What does this mean?").await?;
    let body = requests(&script)
        .into_iter()
        .skip(before)
        .rfind(|body| body.contains("What does this mean?") && body.contains(NOTE))
        .expect("the reply's request carries the note");
    let note = &body[body.rfind(NOTE).unwrap()..];
    assert!(note.contains("Step 2 (run together):"), "{note}");
    assert!(
        note.contains(&format!("canon:epic/{}: blocked", epics[0])),
        "{note}"
    );
    assert!(
        note.contains(&format!(
            "canon:epic/{}: held behind canon:epic/{}",
            epics[1], epics[0]
        )),
        "{note}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The whole-order form goes through the same revision check and pins as the UI.
#[tokio::test]
async fn set_order_replaces_the_unfinished_steps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-SET-ORDER", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    let revision = view["graph_revision"].clone();
    let path = format!("/sessions/{chat}/canon/queue");
    let post = |body: Value| s.gw.post(&path, body);
    let stale = post(
        json!({"op":"set_order","expected_revision":0,"steps":[[epics[0]],[epics[2]],[epics[1]]]}),
    )
    .await?;
    assert_eq!(stale.status, 409, "{}", stale.text);
    let moved = post(json!({"op":"set_order","expected_revision":revision,"steps":[[epics[2]],[epics[0]],[epics[1]]]})).await?;
    assert_ne!(moved.status, 200, "a running step stays where it is");
    let missing = post(
        json!({"op":"set_order","expected_revision":revision,"steps":[[epics[0]],[epics[2]]]}),
    )
    .await?;
    assert_ne!(missing.status, 200, "every unfinished epic is named");
    // The pinned first step may be left out: it keeps its place.
    let view = data(
        post(json!({"op":"set_order","expected_revision":revision,"steps":[[epics[2],epics[1]]]}))
            .await?,
        200,
    );
    assert_eq!(
        view["chains"][0]["steps"][0]["items"][0]["epic_id"], epics[0],
        "{view}"
    );
    let steps = &view["chains"][0]["steps"];
    assert_eq!(steps.as_array().unwrap().len(), 2, "{view}");
    assert_eq!(steps[1]["items"].as_array().unwrap().len(), 2, "{view}");
    script.release();
    wait_done(&s, &chat, 3).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A Steward reads the 과제 it serves through its parent Work, and gets no run note.
#[tokio::test]
async fn steward_reads_its_epic_without_a_tool() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-STEWARD", false, false).await?;
    let (plan, _) = plan(&s, &script, &first).await?;
    script.delegate.store(true, Ordering::SeqCst);
    script.release();
    run_plan(&s, &chat, &plan).await?;
    wait_done(&s, &chat, 3).await?;
    let steward = requests(&script)
        .into_iter()
        .find(|body| body.contains("You run one delegated Work for Butler"))
        .expect("a Steward round");
    assert!(
        steward.contains("## Canon epic this delegated Work serves"),
        "{steward}"
    );
    assert!(steward.contains("Release checks"));
    assert!(!steward.contains(NOTE));
    s.finish().await?;
    server.abort();
    Ok(())
}
