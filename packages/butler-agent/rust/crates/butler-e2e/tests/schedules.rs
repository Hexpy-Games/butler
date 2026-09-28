//! Schedules (예약 작업) run with their own access mode (#237), whatever the
//! access mode of the conversation they post into.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::gateway::{TERMINAL, turn_state};
use butler_e2e::e2e::scenario::{Scenario, Setup, turn_timeout};
use butler_e2e::e2e::{HarnessError, nonce};
use serde_json::{Value, json};

async fn new_chat(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"kind": "chat", "title": title}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

async fn set_chat_access(s: &Scenario, chat: &str, access: &str) -> Result<(), HarnessError> {
    let reply =
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"access_mode": access}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(())
}

/// Creates an hourly schedule; `access` is left out when `None`.
async fn create(
    s: &Scenario,
    chat: &str,
    prompt: &str,
    access: Option<&str>,
) -> Result<Value, HarnessError> {
    let mut body = json!({"title": "E2E schedule", "prompt_body": prompt,
        "target_session_id": chat, "interval_seconds": 3600});
    if let Some(access) = access {
        body["access_mode"] = access.into();
    }
    let reply = s.gw.post("/automations", body).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["automation"].clone())
}

/// Runs the schedule now and waits until its turn waits for an approval or ends.
async fn run(s: &Scenario, chat: &str, schedule: &Value) -> Result<(String, Value), HarnessError> {
    let id = schedule["id"].as_str().unwrap();
    let reply =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let turn_id = reply.data()["run"]["turn_id"]
        .as_str()
        .unwrap_or_else(|| panic!("no turn for the run: {}", reply.text))
        .to_owned();
    let states: Vec<&str> = TERMINAL
        .iter()
        .copied()
        .chain(["waiting_for_form"])
        .collect();
    let turn =
        s.gw.wait_turn(chat, &turn_id, &states, Duration::from_secs(turn_timeout()))
            .await?;
    Ok((turn_id, turn))
}

fn make_file(name: &str) -> String {
    format!("Create a file named {name} in your workspace containing exactly the text: scheduled")
}

/// ACC-06 (#235) — the pending request says what it would do as data the
/// App phrases in the user's language: edit one file, in the workspace
/// folder, medium risk.
fn assert_file_edit_approval(request: &Value, file: &str) {
    let approval = &request["approval"];
    assert_eq!(approval["action_kind"], "edit_files", "{request}");
    assert_eq!(approval["count"], 1, "{request}");
    assert_eq!(approval["risk"], "medium", "{request}");
    let targets = approval["targets"].as_array().unwrap();
    assert_eq!(targets[0]["kind"], "folder", "{request}");
    assert!(
        targets
            .iter()
            .any(|target| target["kind"] == "file"
                && target["path"].as_str().unwrap().ends_with(file)),
        "{request}"
    );
    let examples = approval["examples"].as_array().unwrap();
    assert_eq!(examples.len(), 1, "{request}");
    assert!(examples[0].as_str().unwrap().ends_with(file), "{request}");
}

/// SCHED-01 — An ask-first schedule posting into a full-access conversation
/// asks before its effect; a full-access schedule posting into an ask-first
/// conversation runs without asking.
#[tokio::test]
async fn sched_01_schedule_runs_with_its_own_access_mode() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = nonce();
    let s = Setup::new("SCHED-01")?
        .cassette("SCHED-01")
        .placeholder("NONCE", &token)
        .start()
        .await?;
    assert_eq!(s.gw.settings().await?["access_mode"], "full_access");

    let asked = format!("ask-{token}.txt");
    let schedule = create(&s, "general", &make_file(&asked), Some("ask_first")).await?;
    assert_eq!(schedule["access_mode"], "ask_first", "{schedule}");
    let (turn_id, turn) = run(&s, "general", &schedule).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    let request = requests
        .iter()
        .find(|request| request["source_turn_id"] == turn_id.as_str())
        .unwrap_or_else(|| panic!("no approval request for the ask-first schedule: {requests:?}"));
    assert_file_edit_approval(request, &asked);
    assert!(
        !s.sandbox.data.join(&asked).exists(),
        "the ask-first schedule wrote before approval"
    );

    let strict = new_chat(&s, "strict").await?;
    set_chat_access(&s, &strict, "ask_first").await?;
    let written = format!("full-{token}.txt");
    let schedule = create(&s, &strict, &make_file(&written), Some("full_access")).await?;
    assert_eq!(schedule["access_mode"], "full_access", "{schedule}");
    let (_, turn) = run(&s, &strict, &schedule).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = s.gw.approval_requests(&strict).await?;
    assert!(
        requests.is_empty(),
        "the full-access schedule asked: {requests:?}"
    );
    let content = std::fs::read_to_string(s.sandbox.data.join(&written))?;
    assert_eq!(content.trim(), "scheduled");
    let controls = s.gw.get(&format!("/sessions/{strict}/controls")).await?;
    assert!(
        controls.text.contains("ask_first"),
        "the run changed the conversation's mode: {}",
        controls.text
    );
    s.finish().await
}

/// SCHED-02 — The schedule API carries `access_mode`: create takes it (or the
/// target conversation's current mode), update replaces it, reads return it,
/// and an unknown mode is refused.
#[tokio::test]
async fn sched_02_schedule_api_carries_access_mode() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SCHED-02")?.start().await?;
    let inherited = create(&s, "general", "Summarize my day.", None).await?;
    assert_eq!(inherited["access_mode"], "full_access", "{inherited}");

    let strict = new_chat(&s, "strict").await?;
    set_chat_access(&s, &strict, "ask_first").await?;
    let inherited = create(&s, &strict, "Summarize my day.", None).await?;
    assert_eq!(inherited["access_mode"], "ask_first", "{inherited}");

    let id = inherited["id"].as_str().unwrap();
    let updated =
        s.gw.patch(
            &format!("/automations/{id}"),
            json!({"access_mode": "full_access"}),
        )
        .await?;
    assert_eq!(updated.status, 200, "{}", updated.text);
    assert_eq!(updated.data()["automation"]["access_mode"], "full_access");
    let read = s.gw.get(&format!("/automations/{id}")).await?;
    assert_eq!(read.data()["automation"]["access_mode"], "full_access");
    let listed = s.gw.get("/automations").await?;
    assert!(
        listed.data()["automations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|schedule| schedule["access_mode"].is_string()),
        "{}",
        listed.text
    );

    let refused =
        s.gw.post(
            "/automations",
            json!({"title": "E2E schedule", "prompt_body": "Summarize my day.",
                "target_session_id": "general", "interval_seconds": 3600,
                "access_mode": "sometimes"}),
        )
        .await?;
    assert_eq!(refused.status, 400, "{}", refused.text);
    s.finish().await
}

/// SCHED-03 — The CLI command is `butler schedule`; `butler automation` still
/// works, hidden from help, with one deprecation line on stderr.
#[tokio::test]
async fn sched_03_cli_is_schedule_with_a_deprecated_alias() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SCHED-03")?.start().await?;
    let current = s.agent.cli(&["schedule", "list", "--json"])?;
    assert_eq!(current.code, Some(0), "{}", current.stderr);
    assert_eq!(current.json()?["command"], "butler schedule list");
    assert!(!current.stderr.contains("deprecated"), "{}", current.stderr);
    let alias = s.agent.cli(&["automation", "list", "--json"])?;
    assert_eq!(alias.code, Some(0), "{}", alias.stderr);
    assert_eq!(alias.json()?, current.json()?);
    assert_eq!(
        alias
            .stderr
            .matches("butler automation is deprecated; use butler schedule.")
            .count(),
        1,
        "{}",
        alias.stderr
    );
    let help = s.agent.cli(&["help", "--json"])?;
    assert!(
        help.stdout.contains("butler schedule list"),
        "{}",
        help.stdout
    );
    assert!(
        !help.stdout.contains("butler automation"),
        "{}",
        help.stdout
    );
    s.finish().await
}
