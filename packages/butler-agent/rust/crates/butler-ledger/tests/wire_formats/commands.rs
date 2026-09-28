//! Every Ledger CLI command family, success and failure, and the read ports
//! over the records they leave behind.

use serde_json::json;

use butler_ledger::project_ledger::{
    LedgerCommand as C, PlanRecordRead, ProjectBriefingTarget, ProjectLedgerBinding,
    ProjectWorkPlanRead,
};

use super::golden::assert_golden;
use super::harness::{APP_PROJECT, Harness, LEDGER_PROJECT};

pub(crate) async fn ledger_commands_keep_their_files_and_envelopes() {
    let mut h = Harness::new("commands");
    h.command("status before init", C::Status, json!({})).await;
    h.command("query before init", C::Query, json!({"kind": " work "}))
        .await;
    h.init().await;
    h.init().await;
    h.command("status after init", C::Status, json!({})).await;
    create_records(&mut h).await;
    work_lifecycle(&mut h).await;
    update_records(&mut h).await;
    queries(&mut h).await;
    views(&mut h).await;
    reads(&mut h).await;
    broken_records(&mut h).await;
    h.ledger.close().await;
    assert_golden("commands.txt", &h.finish());
}

#[rustfmt::skip]
async fn create_records(h: &mut Harness) {
    for (kind, id, extra) in [
        ("initiative", "INIT-1", json!({"body": "Initiative body\n"})),
        ("decision", "DEC-1", json!({"reason": "Chosen for speed"})),
        ("risk", "RISK-1", json!({"parentId": "INIT-1"})),
        ("risk", "RISK-2", json!({"mitigation": "Canary rollout", "status": "mitigated"})),
        ("spec", "SPEC-1", json!({"acceptance": "It works", "priority": "3"})),
        ("plan", "PLAN-1", json!({"body": "Plan body\nline two\n"})),
        ("report", "REP-1", json!({})),
        ("handoff", "HAND-1", json!({"body": "Next steps"})),
        ("reference", "REF-1", json!({"logicalId": "doc-1"})),
        ("roadmap", "MAP-1", json!({"priority": 1.5})),
    ] {
        let mut options = json!({"kind": kind, "id": id, "title": format!("{kind} {id}")});
        options.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        h.command(&format!("record create {kind} {id}"), C::RecordCreate, options).await;
    }
    for (step, options) in [
        ("unsupported kind", json!({"kind": "note", "id": "N-1", "title": "Note"})),
        ("duplicate", json!({"kind": "plan", "id": "PLAN-1", "title": "Again"})),
        ("missing title", json!({"kind": "plan", "id": "PLAN-9"})),
        ("unsafe id", json!({"kind": "plan", "id": "../x", "title": "X"})),
        ("body and from", json!({"kind": "plan", "id": "P-2", "title": "X", "body": "b", "from": "f"})),
        ("empty body", json!({"kind": "plan", "id": "P-3", "title": "X", "body": "  "})),
        ("bad priority", json!({"kind": "plan", "id": "P-4", "title": "X", "priority": "high"})),
        ("auto commit", json!({"kind": "plan", "id": "P-5", "title": "X", "code-commit": "auto"})),
    ] {
        h.command(&format!("record create fails: {step}"), C::RecordCreate, options).await;
    }
}

/// Runs each `(step, command, options)` in order.
async fn run(h: &mut Harness, steps: Vec<(&str, C, serde_json::Value)>) {
    for (step, command, options) in steps {
        h.command(step, command, options).await;
    }
}

#[rustfmt::skip]
async fn work_lifecycle(h: &mut Harness) {
    run(h, vec![
        ("work create invalid state", C::WorkCreate, json!({"id": "W-9", "title": "X", "status": "bogus"})),
        ("work create", C::WorkCreate, json!({
            "id": "W-1", "title": "Ship it", "spec": "SPEC-1", "acceptance": "Users can ship",
            "priority": 2, "requires-commit-evidence": true, "body": "Work body\n"})),
        ("work create second", C::WorkCreate, json!({"id": "W-2", "title": "Blocked work", "status": "blocked"})),
        ("task create unknown work", C::TaskCreate, json!({"work": "W-404", "id": "T-9", "title": "X"})),
        ("task create", C::TaskCreate, json!({"work": "W-1", "id": "T-1", "title": "First task"})),
        ("task create second", C::TaskCreate, json!({"work": "W-1", "id": "T-2", "title": "Second task", "validation": "unit"})),
        ("attempt start", C::AttemptStart, json!({"task": "T-1", "id": "A-1", "title": "Try one"})),
        ("attempt start duplicate", C::AttemptStart, json!({"task": "T-1", "id": "A-1"})),
        ("attempt fail", C::AttemptFail, json!({"id": "A-1", "report": "flaky"})),
        ("attempt succeed after fail", C::AttemptSucceed, json!({"id": "A-1"})),
        ("attempt start second", C::AttemptStart, json!({"task": "T-1", "id": "A-2", "body": "Attempt notes"})),
        ("attempt succeed", C::AttemptSucceed, json!({"id": "A-2", "validation": "green"})),
        ("task complete from todo", C::TaskComplete, json!({"id": "T-2"})),
        ("task invalid state", C::TaskUpdate, json!({"id": "T-2", "status": "paused"})),
        ("task update", C::TaskUpdate, json!({"id": "T-1", "status": "in_progress", "title": "First task (renamed)"})),
        ("task complete", C::TaskComplete, json!({"id": "T-1", "report": "done"})),
    ]).await;
    work_transitions(h).await;
}

#[rustfmt::skip]
async fn work_transitions(h: &mut Harness) {
    let evidence = |commits: &str| json!({
        "id": "W-1", "validation": "tests", "review": "ok", "report": "reports/rep-1.md",
        "code-commits": commits, "ledger-commits": "none"});
    run(h, vec![
        ("work jump to done", C::WorkUpdate, json!({"id": "W-1", "status": "done"})),
        ("work update scoped", C::WorkUpdate, json!({"id": "W-1", "status": "scoped"})),
        ("work update specified", C::WorkUpdate, json!({"id": "W-1", "status": "specified"})),
        ("work update in_progress", C::WorkUpdate, json!({"id": "W-1", "status": "in_progress"})),
        ("work update review", C::WorkUpdate, json!({"id": "W-1", "status": "review"})),
        ("work complete gate", C::WorkComplete, json!({"id": "W-1"})),
        ("work complete bad commits", C::WorkComplete, evidence("[{\"repo\":\"r\",\"hash\":\"\"}]")),
        ("work complete", C::WorkComplete, evidence("[{\"repo\":\"butler\",\"hash\":\"abc123\",\"message\":\"ship\"}]")),
        ("work complete twice", C::WorkComplete, json!({"id": "W-1"})),
        ("work update cancelled from blocked", C::WorkUpdate, json!({"id": "W-2", "status": "cancelled", "reason": "Dropped"})),
    ]).await;
}

#[rustfmt::skip]
async fn update_records(h: &mut Harness) {
    h.command("record update plan", C::RecordUpdate, json!({"id": "PLAN-1", "status": "closed", "body": "Closed plan\n"})).await;
    h.command("record update decision", C::RecordUpdate, json!({"id": "DEC-1", "implementation": "W-1", "spec-exemption": "yes"})).await;
    h.command("record update nothing", C::RecordUpdate, json!({"id": "DEC-1"})).await;
    h.command("record update missing", C::RecordUpdate, json!({"id": "NOPE", "title": "x"})).await;
    h.command("record update wrong kind", C::RecordUpdate, json!({"id": "DEC-1", "kind": "risk", "title": "x"})).await;
    h.command("record update attempt transition", C::RecordUpdate, json!({"id": "A-2", "status": "started"})).await;
}

#[rustfmt::skip]
async fn queries(h: &mut Harness) {
    h.command("index", C::Index, json!({})).await;
    for kind in [
        "all", "initiative", "decision", "risk", "spec", "report", "plan", "handoff",
        "reference", "roadmap", "work", "task", "attempt", "next-actions", "blocked", "review",
        "missing-spec", "completion-gaps", "stale-view", "stale-index",
        "decision-without-implementation", "risk-without-mitigation", "recent-completed",
    ] {
        h.command(&format!("query {kind}"), C::Query, json!({"kind": kind})).await;
    }
    for (step, options) in [
        ("filtered", json!({"kind": "all", "status": "active", "query": " PLAN "})),
        ("limited", json!({"kind": "all", "limit": "2"})),
        ("bad limit", json!({"kind": "all", "limit": 0})),
        ("unknown kind", json!({"kind": "notes"})),
        ("missing kind", json!({})),
    ] {
        h.command(&format!("query {step}"), C::Query, options).await;
    }
    h.command("show", C::Show, json!({"id": "PLAN-1", "body": true})).await;
    h.command("show json-less", C::Show, json!({"id": "W-1", "kind": "work"})).await;
    h.command("show missing", C::Show, json!({"id": "NOPE"})).await;
    h.command("show no id", C::Show, json!({})).await;
    h.command("check", C::Check, json!({})).await;
    h.command("status", C::Status, json!({})).await;
}

#[rustfmt::skip]
async fn views(h: &mut Harness) {
    h.command("render dashboard", C::Render, json!({"view": "dashboard"})).await;
    h.command("render handoff write", C::Render, json!({"view": "handoff", "write": true})).await;
    h.command("render roadmap write", C::Render, json!({"view": "roadmap", "write": "yes"})).await;
    h.command("render dashboard write", C::Render, json!({"view": "dashboard", "write": true})).await;
    h.command("render unknown", C::Render, json!({"view": "calendar"})).await;
    h.command("render missing", C::Render, json!({})).await;
    h.command("query stale-view after render", C::Query, json!({"kind": "stale-view"})).await;
}

async fn reads(h: &mut Harness) {
    let workspace = h.data().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        workspace.join("project.json"),
        format!("{{\"id\":\"{LEDGER_PROJECT}\"}}"),
    )
    .unwrap();
    for id in ["PLAN-1", " PLAN-1 ", "W-1", ""] {
        let result = h
            .ledger
            .show_plan_record(PlanRecordRead {
                workspace_path: workspace.to_string_lossy().into_owned(),
                app_project_id: LEDGER_PROJECT.into(),
                plan_id: id.into(),
            })
            .await;
        h.record_debug(&format!("show_plan_record {id:?}"), &result);
    }
    for id in ["W-1", "PLAN-1", "NOPE"] {
        let kinds = h
            .ledger
            .find_canonical_record_kinds(h.root.clone(), id.into())
            .await;
        h.record_debug(&format!("find_canonical_record_kinds {id}"), &kinds);
    }
    dashboard_reads(h).await;
}

async fn dashboard_reads(h: &mut Harness) {
    let binding = ProjectLedgerBinding {
        app_project_id: APP_PROJECT.into(),
        ledger_project_id: LEDGER_PROJECT.into(),
    };
    let snapshot = h.ledger.dashboard_snapshot(binding.clone()).await;
    h.record_debug("dashboard_snapshot", &snapshot);
    let revision = snapshot
        .map(|snapshot| snapshot.revision)
        .unwrap_or_default();
    for (kind, id) in [
        ("plan", "PLAN-1"),
        ("work", "W-1"),
        ("decision", "DEC-1"),
        ("reference", "REF-1"),
        ("plan", "NOPE"),
    ] {
        let source = h
            .ledger
            .read_dashboard_source(binding.clone(), kind.into(), id.into(), revision.clone())
            .await;
        h.record_debug(&format!("read_dashboard_source {kind} {id}"), &source);
    }
    let stale = h
        .ledger
        .read_dashboard_source(
            binding.clone(),
            "plan".into(),
            "PLAN-1".into(),
            "stale".into(),
        )
        .await;
    h.record_debug("read_dashboard_source stale revision", &stale);
    let history = h
        .ledger
        .dashboard_work_history_for_revision(binding.clone(), revision.clone(), None)
        .await;
    h.record_debug("dashboard_work_history_for_revision", &history);
    let history = h
        .ledger
        .read_dashboard_ledger_history(LEDGER_PROJECT.into())
        .await;
    h.record_debug("read_dashboard_ledger_history", &history);
    let signals = h
        .ledger
        .briefing_signals(None, h.data().join("consolidation"))
        .await;
    h.record_debug("briefing_signals all", &signals);
    let signals = h
        .ledger
        .briefing_signals(
            Some(vec![ProjectBriefingTarget {
                id: APP_PROJECT.into(),
                display_name: "Demo".into(),
                ledger_project_id: LEDGER_PROJECT.into(),
                recent_session_titles: vec!["Kickoff".into()],
            }]),
            h.data().join("consolidation"),
        )
        .await;
    h.record_debug("briefing_signals targeted", &signals);
    let plan = h
        .ledger
        .read_project_work_plan(ProjectWorkPlanRead {
            app_project_id: APP_PROJECT.into(),
            ledger_project_id: LEDGER_PROJECT.into(),
            work_id: "W-1".into(),
        })
        .await;
    h.record_debug("read_project_work_plan unmanaged", &plan);
}

async fn broken_records(h: &mut Harness) {
    h.write("plans/plan-broken.md", "---\nschema: \"project-ledger.plan.v1\"\nkind: \"plan\"\nid: \"PLAN-1\"\ntitle: \"Duplicate\"\nstatus: \"active\"\n---\n\nAuthorization: Bearer not-a-real-token\n");
    h.write("references/bad.json", "{invalid");
    h.write(
        "work/W-3/work.md",
        "---\nkind: \"work\"\nid: \"W-3\"\nstatus: \"done\"\n---\n",
    );
    h.command("check broken", C::Check, json!({"project": "demo"}))
        .await;
    h.command("index broken", C::Index, json!({})).await;
    h.command(
        "query completion-gaps broken",
        C::Query,
        json!({"kind": "completion-gaps"}),
    )
    .await;
    h.command("show ambiguous", C::Show, json!({"id": "PLAN-1"}))
        .await;
}
