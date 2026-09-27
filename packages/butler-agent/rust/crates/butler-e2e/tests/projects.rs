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

/// PRJ-02 — The Work a project session starts, plans, reviews and settles
/// is on the project dashboard (overview card and its plan in materials)
/// with the status the turn left it in, the same after a restart.
#[tokio::test]
async fn prj_02_project_work_shows_on_dashboard() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, project, _) = prj_02_turn("PRJ-02").await?;
    let view = dashboard(&s, &project).await?;
    assert_eq!(view["overview"]["status"], "ready", "{}", view["overview"]);
    assert_eq!(view["overview"]["totalWorks"], 1, "{}", view["overview"]);
    let works = overview_works(&view);
    assert_eq!(works.len(), 1, "{works:?}");
    let (work_id, title, status) = works[0].clone();
    assert!(work_id.starts_with("guided-work-"), "{work_id}");
    assert!(title.contains("Build three raised garden beds"), "{title}");
    // The recorded turn settles its Work as blocked (see the PRJ-02-LEDGER gap).
    assert_eq!(status, "blocked");
    assert_eq!(
        view["overview"]["progress"]["blocked"], 1,
        "{}",
        view["overview"]
    );
    let materials =
        s.gw.get(&format!("/projects/{project}/dashboard/materials"))
            .await?;
    assert_eq!(materials.data()["status"], "ready", "{}", materials.text);
    assert!(
        materials.data()["documents"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|document| document["kind"] == "plan"),
        "the Work's plan is not in the dashboard materials: {}",
        materials.text
    );
    let status_view = s.gw.get("/work-status").await?;
    assert_eq!(status_view.status, 200, "{}", status_view.text);
    assert_eq!(
        status_view.data()["counts"]["attention"],
        1,
        "{}",
        status_view.text
    );

    s.restart().await?;
    let after = dashboard(&s, &project).await?;
    assert_eq!(
        overview_works(&after),
        works,
        "dashboard Work changed across restart"
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
    std::fs::read_dir(&plans)
        .unwrap()
        .flatten()
        .next()
        .unwrap()
        .path()
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
