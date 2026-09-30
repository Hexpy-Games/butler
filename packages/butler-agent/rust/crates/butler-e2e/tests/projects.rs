//! G. Project work and dashboard (SCENARIOS.md PRJ-02, PRJ-03).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::{Value, json};

/// Creates a scratch project and a session bound to it.
async fn project_session(s: &Scenario, name: &str) -> Result<(String, String), HarnessError> {
    let created =
        s.gw.post(
            "/projects",
            json!({"source": "scratch", "display_name": name}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
    let session =
        s.gw.post(
            "/sessions",
            json!({"kind": "project", "title": "Plan", "project_id": project}),
        )
        .await?;
    assert_eq!(session.status, 201, "{}", session.text);
    let chat = session.data()["session"]["id"].as_str().unwrap().to_owned();
    Ok((project, chat))
}

/// A new App project must initialize its canonical Ledger on its first turn.
#[tokio::test]
async fn prj_first_turn_initializes_ledger() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("PRJ-FIRST-TURN")?
        .cassette("PRJ-02")
        .replay_only()
        .start()
        .await?;
    let (project, chat) = project_session(&s, "Garden Beds").await?;
    let ledger = s
        .sandbox
        .data
        .join("project-ledger/projects")
        .join(&project);
    assert!(
        !ledger.exists(),
        "Ledger was initialized before the first turn"
    );
    let (_, turn) = s.turn(&chat, PRJ_02_PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let metadata: Value = serde_json::from_slice(&std::fs::read(ledger.join("project.json"))?)?;
    assert_eq!(metadata["id"], project);
    assert!(
        std::fs::read_to_string(ledger.join("ledger.jsonl"))?
            .contains("\"type\":\"project_initialized\""),
        "project initialization event missing"
    );
    s.finish().await
}

const PRJ_02_PROMPT: &str = "Track this in the project as one work item: \"Build three raised garden beds\". Create it, record a short review that the plan is sound, then mark it completed. Use only your work and ledger tools; do not create or edit files.";

/// Runs the PRJ-02 turn in a fresh project session.
async fn prj_02_turn(id: &str) -> Result<(Scenario, String, String), HarnessError> {
    prj_02_turn_with(Setup::new(id)?.cassette("PRJ-02")).await
}

async fn prj_02_turn_with(setup: Setup) -> Result<(Scenario, String, String), HarnessError> {
    let s = setup.start().await?;
    let (project, chat) = project_session(&s, "Garden Beds").await?;
    let (_, turn) = s.turn(&chat, PRJ_02_PROMPT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    Ok((s, project, chat))
}

async fn dashboard(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(&format!("/projects/{project}/dashboard")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

/// The Work cards of the dashboard overview: `(id, title, status)`.
fn overview_works(dashboard: &Value) -> Vec<(String, String, String)> {
    dashboard["overview"]["remaining"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|card| {
            (
                card["id"].as_str().unwrap_or_default().to_owned(),
                card["title"].as_str().unwrap_or_default().to_owned(),
                card["executionStatus"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            )
        })
        .collect()
}

/// The dashboard's view of the project's one Work: its execution status,
/// read from the overview's progress counts (they cover every Work), and its
/// overview card `(id, title, status)` (only open and blocked Works have one).
type DashboardWork = (String, Option<(String, String, String)>);

fn dashboard_work(view: &Value) -> DashboardWork {
    let overview = &view["overview"];
    assert_eq!(overview["status"], "ready", "{overview}");
    assert_eq!(overview["totalWorks"], 1, "{overview}");
    let counted: Vec<(String, u64)> = overview["progress"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(status, count)| Some((status.clone(), count.as_u64()?)))
        .filter(|(_, count)| *count > 0)
        .collect();
    let [(status, 1)] = counted.as_slice() else {
        panic!("progress does not count the one Work once: {overview}");
    };
    let mut cards = overview_works(view);
    assert!(cards.len() <= 1, "{cards:?}");
    (status.clone(), cards.pop())
}

/// The `/work-status` state of the Work of project session `chat`; the
/// counts agree with the items.
async fn work_status_state(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let reply = s.gw.get("/work-status").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let sessions = s.gw.get("/sessions").await?;
    let hint = sessions.data()["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|session| session["id"] == chat)
        .and_then(|session| session["session_hint"].as_str())
        .unwrap_or(chat)
        .to_owned();
    let items = reply.data()["items"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mine: Vec<&Value> = items
        .iter()
        .filter(|item| item["session_id"] == chat || item["session_id"] == hint.as_str())
        .collect();
    let [item] = mine.as_slice() else {
        panic!(
            "the project session's Work is not in /work-status once: {}",
            reply.text
        );
    };
    let state = item["state"].as_str().unwrap_or_default().to_owned();
    let same = items
        .iter()
        .filter(|other| other["state"] == state.as_str())
        .count();
    assert_eq!(
        reply.data()["counts"][state.as_str()].as_u64(),
        Some(same as u64),
        "counts disagree with the items: {}",
        reply.text
    );
    Ok(state)
}

/// Whether a `/work-status` state says the same as a dashboard status.
fn agrees(dashboard_status: &str, work_status_state: &str) -> bool {
    matches!(
        (dashboard_status, work_status_state),
        ("completed", "completed") | ("blocked", "attention") | ("open", "running" | "attention")
    )
}

/// PRJ-02 — The Work a project session starts, plans, reviews and settles
/// is on the project dashboard (its status, its overview card while it is
/// open or blocked, and its plan in materials); `/work-status` agrees with
/// the dashboard, and both say the same after a restart. (Which status the
/// turn leaves is the PRJ-02-LEDGER test's concern.)
#[tokio::test]
async fn prj_02_project_work_shows_on_dashboard() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, project, chat) = prj_02_turn("PRJ-02").await?;
    let work = dashboard_work(&dashboard(&s, &project).await?);
    match (work.0.as_str(), &work.1) {
        ("open" | "blocked", Some((id, title, status))) => {
            assert!(id.starts_with("guided-work-"), "{id}");
            assert!(title.contains("Build three raised garden beds"), "{title}");
            assert_eq!(status, &work.0, "card and progress disagree");
        }
        ("completed", None) => {}
        _ => panic!("the Work's status and overview card disagree: {work:?}"),
    }
    let documents = materials(&s, &project).await?;
    assert_eq!(documents["status"], "ready", "{documents}");
    assert!(
        documents["documents"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|document| document["kind"] == "plan"),
        "the Work's plan is not in the dashboard materials: {documents}"
    );
    let state = work_status_state(&s, &chat).await?;
    assert!(
        agrees(&work.0, &state),
        "the dashboard says {}, /work-status says {state}",
        work.0
    );

    s.restart().await?;
    assert_eq!(
        dashboard_work(&dashboard(&s, &project).await?),
        work,
        "dashboard Work changed across restart"
    );
    assert_eq!(
        work_status_state(&s, &chat).await?,
        state,
        "/work-status changed across restart"
    );
    s.finish().await
}

/// PRJ-02 — The requested work item is created, reviewed and completed.
#[tokio::test]
#[ignore = "product gap: PRJ-02-LEDGER — in a new scratch project session, project_ledger_create for the requested work item fails `effect_dispatch_failed: project_ledger_effect_not_applied` (twice, same arguments; the publication receipt says not_applied without a reason), so the item never exists and the managed Work ends blocked; the failed call's output is not viewable (GET …/operations/{call}/output answers 404 operation_output_not_found)"]
async fn prj_02_requested_item_is_completed() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project, _) = prj_02_turn_with(
        Setup::new("PRJ-02-LEDGER")?
            .cassette("PRJ-02")
            .replay_only(),
    )
    .await?;
    let view = dashboard(&s, &project).await?;
    assert!(
        view["overview"]["progress"]["completed"].as_u64() >= Some(1),
        "nothing completed: {}",
        view["overview"]
    );
    s.finish().await
}

/// PRJ-02 — `butler work list` agrees with the project dashboard.
#[tokio::test]
#[ignore = "product gap: PRJ-02-CLI — `butler work list --json` reads legacy task records only: it returns no items while the project dashboard overview shows the session's managed Work"]
async fn prj_02_cli_lists_dashboard_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project, _) =
        prj_02_turn_with(Setup::new("PRJ-02-CLI")?.cassette("PRJ-02").replay_only()).await?;
    let works = overview_works(&dashboard(&s, &project).await?);
    let list = s
        .agent
        .cli_async(&["work", "list", "--json"])
        .await?
        .json()?;
    for (id, _, _) in &works {
        assert!(
            list.to_string().contains(id.as_str()),
            "{id} not listed: {list}"
        );
    }
    s.finish().await
}

/// Polls the dashboard until the briefing leaves `generating`.
async fn settled_briefing(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(butler_e2e::e2e::scenario::turn_timeout());
    loop {
        let briefing = dashboard(s, project).await?["briefing"].clone();
        if briefing["status"] != "generating" || std::time::Instant::now() > deadline {
            return Ok(briefing);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// Runs the PRJ-02 turn (replayed from PRJ-02) and requests the project
/// briefing (the PRJ-03 recording).
async fn prj_03_project(id: &str) -> Result<(Scenario, String), HarnessError> {
    let mut setup = Setup::new(id)?.cassette("PRJ-03").extends("PRJ-02");
    // Only the main PRJ-03 scenario records the cassette.
    if id != "PRJ-03" {
        setup = setup.replay_only();
    }
    let (s, project, _) = prj_02_turn_with(setup).await?;
    let before = dashboard(&s, &project).await?;
    assert_eq!(
        before["briefing"]["status"], "needed",
        "{}",
        before["briefing"]
    );
    let revision = before["briefing"]["sourceRevision"]
        .as_str()
        .unwrap()
        .to_owned();
    let requested =
        s.gw.post(
            &format!("/projects/{project}/dashboard/briefing"),
            json!({"sourceRevision": revision}),
        )
        .await?;
    assert_eq!(requested.status, 202, "{}", requested.text);
    assert_eq!(
        requested.data()["status"],
        "generating",
        "{}",
        requested.text
    );
    Ok((s, project))
}

/// The first plan record file of the project's ledger.
fn plan_file(s: &Scenario, project: &str) -> std::path::PathBuf {
    let plans = s
        .sandbox
        .data
        .join("project-ledger/projects")
        .join(project)
        .join("plans");
    let mut entries: Vec<_> = std::fs::read_dir(&plans).unwrap().flatten().collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    entries.first().unwrap().path()
}

async fn materials(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    let reply =
        s.gw.get(&format!("/projects/{project}/dashboard/materials"))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

/// PRJ-03 — A briefing request that the provider rejects (the real reply
/// recorded for it) leaves the dashboard working: the briefing settles as
/// unavailable, a retry is accepted, and the new-chat briefing falls back.
/// A malformed ledger record on disk does not break the dashboard, its
/// materials or records, or the work CLI.
#[tokio::test]
async fn prj_03_dashboard_survives_briefing_failure_and_broken_record() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, project) = prj_03_project("PRJ-03").await?;
    let briefing = settled_briefing(&s, &project).await?;
    assert_eq!(briefing["status"], "unavailable", "{briefing}");
    assert!(briefing["content"].is_null(), "{briefing}");
    let retry =
        s.gw.post(
            &format!("/projects/{project}/dashboard/briefing"),
            json!({"sourceRevision": briefing["sourceRevision"], "retry": true}),
        )
        .await?;
    assert_eq!(retry.status, 202, "retry refused: {}", retry.text);
    assert_eq!(
        settled_briefing(&s, &project).await?["status"],
        "unavailable"
    );
    let fallback =
        s.gw.get(&format!("/new-chat-briefing?project_id={project}"))
            .await?;
    assert_eq!(fallback.status, 200, "{}", fallback.text);
    assert!(
        fallback.data()["suggestions"]
            .as_array()
            .is_some_and(|list| !list.is_empty()),
        "{}",
        fallback.text
    );

    std::fs::write(
        plan_file(&s, &project),
        "---\nid: [unterminated\n\u{0}garbage",
    )?;
    for phase in ["after damage", "after restart"] {
        let view = dashboard(&s, &project).await?;
        assert_eq!(
            view["overview"]["totalWorks"], 1,
            "{phase}: {}",
            view["overview"]
        );
        assert_eq!(materials(&s, &project).await?["status"], "ready", "{phase}");
        let records =
            s.gw.get(&format!("/projects/{project}/dashboard/records?kind=plan"))
                .await?;
        assert_eq!(records.status, 200, "{phase}: {}", records.text);
        let work = s.agent.cli_async(&["work", "list", "--json"]).await?;
        assert_eq!(
            work.code,
            Some(0),
            "{phase}: {} {}",
            work.stdout,
            work.stderr
        );
        if phase == "after damage" {
            s.restart().await?;
        }
    }
    s.finish().await
}

/// PRJ-03 — The project briefing is generated.
#[tokio::test]
#[ignore = "product gap: PRJ-03-BRIEFING — the project dashboard briefing request sends max_output_tokens, which the ChatGPT subscription (Codex) endpoint rejects with 400 {\"detail\":\"Unsupported parameter: max_output_tokens\"} (the PRJ-03 recording), so a subscription user's project briefing is never available"]
async fn prj_03_project_briefing_is_generated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = prj_03_project("PRJ-03-READY").await?;
    let briefing = settled_briefing(&s, &project).await?;
    assert_eq!(briefing["status"], "ready", "{briefing}");
    assert!(
        briefing["content"]["introduction"].is_string(),
        "{briefing}"
    );
    s.finish().await
}

/// PRJ-03 — A malformed ledger record is flagged; the valid Work stays listed.
#[tokio::test]
#[ignore = "product gap: PRJ-03-BROKEN — after one plan record file of the project ledger is overwritten with garbage, the dashboard still shows that plan as a normal active document (materials unavailable:false, records lane active) while the intact Work drops out of the overview (executionStatus blocked -> progress unknown, remaining empty)"]
async fn prj_03_broken_record_is_flagged() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = prj_03_project("PRJ-03-BROKEN").await?;
    settled_briefing(&s, &project).await?;
    let works = overview_works(&dashboard(&s, &project).await?);
    let plan = plan_file(&s, &project);
    let plan_id = plan.file_stem().unwrap().to_string_lossy().into_owned();
    std::fs::write(&plan, "---\nid: [unterminated\n\u{0}garbage")?;
    let view = dashboard(&s, &project).await?;
    assert_eq!(
        overview_works(&view),
        works,
        "the valid Work is no longer listed: {}",
        view["overview"]
    );
    let documents = materials(&s, &project).await?;
    let flagged = documents["documents"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|document| document["id"] == plan_id.as_str())
        .is_none_or(|document| document["unavailable"] == true);
    assert!(flagged, "the broken plan is shown as valid: {documents}");
    s.finish().await
}
