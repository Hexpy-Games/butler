//! Project Work through the BTCC repository port: the managed Work records,
//! their child records, publication claims and journals, the lock shard, and
//! the dashboard projections over them.

use std::sync::Arc;

use butler_ledger::project_ledger::{
    LedgerCommand, ProjectBriefingTarget, ProjectLedgerBinding, ProjectWork, ProjectWorkPlanRead,
};
use butler_turn::btcc::{
    ActionProgress, ActionStatus, BtccError, BtccStorage, CheckpointCommand, CheckpointInput,
    ClaimCloseoutCorrectionInput, ContinueWorkCommand, ContinueWorkInput, DispositionActionUpdate,
    DispositionCommand, DispositionInput, DispositionStatus, DurableWorkRepository,
    LegacyProjectWorkSource, LegacyProjectWorkSourceSnapshot, PlanAction, PortFuture,
    ReplacePlanCommand, ReplacePlanInput, ReviewCommand, ReviewInput, ReviewSubject, ReviewVerdict,
    SqliteProjectWorkRuntime, StartWorkCommand, StartWorkInput, TestStorageFixture, WorkStage,
    WorkTurnScope, WorkView,
};

use super::golden::assert_golden;
use super::harness::{APP_PROJECT, Harness, LEDGER_PROJECT};

/// No Work predates the Ledger in these scenarios.
struct NoLegacyWork;

impl LegacyProjectWorkSource for NoLegacyWork {
    fn load_open_work(
        &self,
        _project_ref: String,
        _program_ids: Vec<String>,
    ) -> PortFuture<'_, Option<LegacyProjectWorkSourceSnapshot>> {
        Box::pin(async { Ok(None) })
    }
}

const TURNS: [&str; 3] = ["turn-1", "turn-2", "turn-3"];

/// The real BTCC Project Work runtime over a fresh store with a fixed clock
/// and one admitted Turn row per scenario Turn.
async fn runtime(fixture: &TestStorageFixture) -> Arc<SqliteProjectWorkRuntime> {
    let config = fixture.config("ledger-wire-formats");
    let path = config.path.clone();
    let storage = BtccStorage::open(config).await.unwrap();
    let connection = rusqlite::Connection::open(path).unwrap();
    for (index, turn) in TURNS.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id, \
                 original_message,admission_snapshot_ref,model_selection_json,context_json, \
                 semantic_state,revision,execution_fence) \
                 VALUES(?1,'session-1',?2,?3,?4,'Ship the feature','snapshot','{}','{}','admitted',1,1)",
                rusqlite::params![turn, format!("inbox-{index}"), format!("trigger-{index}"), format!("message-{turn}")],
            )
            .unwrap();
    }
    Arc::new(SqliteProjectWorkRuntime::new(
        storage,
        Arc::new(|| "2026-01-02T03:04:05.000Z".to_owned()),
        Arc::new(NoLegacyWork),
    ))
}

fn turn(turn: &str) -> WorkTurnScope {
    WorkTurnScope {
        turn_id: turn.into(),
        session_id: "session-1".into(),
        project_ref: Some(APP_PROJECT.into()),
    }
}

fn sha(label: &str) -> String {
    butler_turn::btcc::digest_identity(label)
}

fn action(key: &str, description: &str, dependencies: &[&str]) -> PlanAction {
    PlanAction {
        action_key: key.into(),
        description: description.into(),
        dependency_keys: dependencies.iter().map(|key| (*key).to_owned()).collect(),
        effect: None,
    }
}

fn progress(items: &[(&str, ActionStatus)]) -> Vec<ActionProgress> {
    items
        .iter()
        .map(|(key, status)| ActionProgress {
            action_key: (*key).into(),
            status: *status,
            note: None,
        })
        .collect()
}

/// The view's current plan id and checkpoint revision, or empty values.
fn plan_state(view: &Result<WorkView, BtccError>) -> (String, u64) {
    let Ok(view) = view else {
        return (String::new(), 0);
    };
    (
        view.current_plan
            .as_ref()
            .map(|plan| plan.plan_revision_id.clone())
            .unwrap_or_default(),
        view.latest_checkpoint
            .as_ref()
            .map_or(0, |checkpoint| checkpoint.revision),
    )
}

fn outcome<T: std::fmt::Debug>(result: Result<T, BtccError>) -> Result<T, String> {
    result.map_err(|error| error.code().to_owned())
}

struct Plan<'a> {
    turn: &'a str,
    call: &'a str,
    objective: &'a str,
    actions: Vec<PlanAction>,
    progress: Vec<ActionProgress>,
    expected_work_id: Option<String>,
    opening_plan: bool,
}

fn plan_command(plan: Plan<'_>) -> ReplacePlanCommand {
    let checks = if plan.opening_plan {
        vec!["tests pass".to_owned()]
    } else {
        Vec::new()
    };
    ReplacePlanCommand {
        input: ReplacePlanInput {
            scope: turn(plan.turn),
            mutation_call_id: plan.call.into(),
            start_new: None,
            backfill_tool_call_ids: None,
            objective: plan.objective.into(),
            governing_refs: plan.opening_plan.then(|| vec!["SPEC-1".into()]),
            execution_mode: None,
            actions: plan.actions,
            checks,
        },
        request_sha256: sha(plan.call),
        start_new: false,
        governing_refs: if plan.opening_plan {
            vec!["SPEC-1".into()]
        } else {
            Vec::new()
        },
        expected_work_id: plan.expected_work_id,
        expected_progress_revision: Some(0),
        action_progress: plan.progress,
        opening_plan: plan.opening_plan,
    }
}

struct Review<'a> {
    turn: &'a str,
    call: &'a str,
    subject: ReviewSubject,
    verdict: ReviewVerdict,
    summary: &'a str,
    corrections: Vec<String>,
    stages: [WorkStage; 3],
    plan: (String, u64),
    progress: Vec<ActionProgress>,
}

fn review_command(review: Review<'_>) -> ReviewCommand {
    let [current_stage, entry_stage, next_stage] = review.stages;
    let planning = review.subject == ReviewSubject::Plan;
    ReviewCommand {
        input: ReviewInput {
            scope: turn(review.turn),
            mutation_call_id: review.call.into(),
            subject: review.subject,
            verdict: review.verdict,
            summary: review.summary.into(),
            corrections: review.corrections,
            action_updates: None,
            correction_scope: planning.then_some(butler_turn::btcc::CorrectionScope::Planning),
            next_stage: Some(next_stage),
        },
        expected_plan_revision_id: review.plan.0,
        expected_progress_revision: review.plan.1,
        expected_result_sequence: 0,
        expected_result_review_revision_id: None,
        request_sha256: sha(review.call),
        current_stage,
        entry_stage,
        next_stage,
        action_progress: review.progress,
        progress_changed: !planning,
    }
}

fn checkpoint_command(
    call: &str,
    plan: (String, u64),
    progress: Vec<ActionProgress>,
) -> CheckpointCommand {
    let summary = if progress.is_empty() {
        ""
    } else {
        "Code written"
    };
    let next = if progress.is_empty() {
        ""
    } else {
        "Run the tests"
    };
    CheckpointCommand {
        input: CheckpointInput {
            scope: turn("turn-1"),
            mutation_call_id: call.into(),
            next_stage: (!progress.is_empty()).then_some(WorkStage::Execution),
            action_updates: None,
            public_summary: (!summary.is_empty()).then(|| summary.into()),
            next_step: (!next.is_empty()).then(|| next.into()),
        },
        expected_plan_revision_id: plan.0,
        expected_progress_revision: plan.1,
        request_sha256: sha(call),
        stage: WorkStage::Execution,
        action_progress: progress,
        public_summary: summary.into(),
        next_step: next.into(),
    }
}

fn start_command(turn_id: &str, call: &str, objective: &str) -> StartWorkCommand {
    StartWorkCommand {
        input: StartWorkInput {
            scope: turn(turn_id),
            mutation_call_id: call.into(),
            objective: objective.into(),
            backfill_tool_call_ids: None,
        },
        request_sha256: sha(call),
    }
}

fn disposition_command(work_id: &str) -> DispositionCommand {
    DispositionCommand {
        input: DispositionInput {
            scope: turn("turn-1"),
            mutation_call_id: "call-disposition".into(),
            work_id: work_id.into(),
            disposition: DispositionStatus::Completed,
            summary: "Shipped".into(),
            action_updates: None,
            remaining_actions: None,
            next_condition: None,
            evidence_refs: None,
            followups: Some(vec!["Announce it".into()]),
            backfill_tool_call_ids: None,
            expected_material_fingerprint: None,
            runtime_owned_open_generation: None,
        },
        request_sha256: sha("call-disposition"),
        normalized_summary: "Shipped".into(),
        action_updates: vec![DispositionActionUpdate {
            action_key: "test".into(),
            status: ActionStatus::Done,
            note: Some("green".into()),
        }],
        remaining_actions: Vec::new(),
        evidence_refs: Vec::new(),
        followups: vec!["Announce it".into()],
    }
}

pub(crate) async fn project_work_keeps_its_records_and_projections() {
    let mut h = Harness::new("work");
    h.init().await;
    let fixture = TestStorageFixture::activated();
    let runtime = runtime(&fixture).await;
    let work = ProjectWork::new(h.ledger.clone(), runtime.clone(), runtime.clone(), runtime);
    let repo = work.repository(h.scope());
    let (work_id, plan_id) = first_work(&mut h, repo.as_ref()).await;
    closeout(&mut h, repo.as_ref(), &work_id).await;
    second_work(&mut h, repo.as_ref()).await;
    work.close().await;
    h.command("index", LedgerCommand::Index, serde_json::json!({}))
        .await;
    h.command("check", LedgerCommand::Check, serde_json::json!({}))
        .await;
    dashboard(&mut h, &work_id, &plan_id).await;
    h.ledger.close().await;
    assert_golden("project_work.txt", &h.finish());
}

/// Start, plan, checkpoint and accept-review the first Work in turn-1.
async fn first_work(h: &mut Harness, repo: &dyn DurableWorkRepository) -> (String, String) {
    let context = repo.load_context(turn("turn-1")).await;
    h.record_debug("load_context before work", &outcome(context));
    let started = repo
        .start_work(start_command("turn-1", "call-start", "Ship the feature"))
        .await;
    let work_id = started
        .as_ref()
        .map(|view| view.work_id.clone())
        .unwrap_or_default();
    h.record_debug("start_work", &outcome(started));
    let bound = repo.bound_work_for_turn("turn-1".into()).await;
    h.record_debug("bound_work_for_turn", &outcome(bound));
    let planned = repo
        .replace_plan(plan_command(Plan {
            turn: "turn-1",
            call: "call-plan",
            objective: "Ship the feature safely",
            actions: vec![
                action("write", "Write the code", &[]),
                action("test", "Test the code", &["write"]),
            ],
            progress: progress(&[
                ("write", ActionStatus::Pending),
                ("test", ActionStatus::Pending),
            ]),
            expected_work_id: Some(work_id.clone()),
            opening_plan: true,
        }))
        .await;
    let plan = plan_state(&planned);
    h.record_debug("replace_plan", &outcome(planned));
    let running = progress(&[
        ("write", ActionStatus::Done),
        ("test", ActionStatus::Active),
    ]);
    let checkpointed = repo
        .record_checkpoint(checkpoint_command("call-checkpoint", plan.clone(), running))
        .await;
    let revision = plan_state(&checkpointed).1;
    h.record_debug("record_checkpoint", &outcome(checkpointed));
    let stale = repo
        .record_checkpoint(checkpoint_command(
            "call-checkpoint-stale",
            (plan.0.clone(), 0),
            Vec::new(),
        ))
        .await;
    h.record_debug("record_checkpoint stale", &outcome(stale));
    let reviewed = repo
        .record_review(review_command(Review {
            turn: "turn-1",
            call: "call-review",
            subject: ReviewSubject::Result,
            verdict: ReviewVerdict::Accept,
            summary: "Looks right",
            corrections: Vec::new(),
            stages: [
                WorkStage::Execution,
                WorkStage::Review,
                WorkStage::Validation,
            ],
            plan: (plan.0.clone(), revision),
            progress: progress(&[("write", ActionStatus::Done), ("test", ActionStatus::Done)]),
        }))
        .await;
    h.record_debug("record_review", &outcome(reviewed));
    (work_id, plan.0)
}

/// Complete the first Work and try to reopen it from another turn.
async fn closeout(h: &mut Harness, repo: &dyn DurableWorkRepository, work_id: &str) {
    let disposed = repo.record_disposition(disposition_command(work_id)).await;
    h.record_debug("record_disposition", &outcome(disposed));
    let context = repo.load_context(turn("turn-1")).await;
    h.record_debug("load_context after disposition", &outcome(context));
    let claimed = repo
        .claim_closeout_correction(ClaimCloseoutCorrectionInput {
            scope: turn("turn-1"),
            work_id: work_id.into(),
        })
        .await;
    h.record_debug("claim_closeout_correction", &outcome(claimed));
    let continued = repo
        .continue_work(ContinueWorkCommand {
            input: ContinueWorkInput {
                scope: turn("turn-2"),
                mutation_call_id: "call-continue".into(),
                work_id: work_id.into(),
                backfill_tool_call_ids: None,
            },
            request_sha256: sha("call-continue"),
        })
        .await;
    h.record_debug("continue_work", &outcome(continued));
}

/// A second Work whose plan is sent back for revision, then abandoned.
async fn second_work(h: &mut Harness, repo: &dyn DurableWorkRepository) {
    let second = repo
        .start_work(start_command("turn-3", "call-start-2", "Follow up"))
        .await;
    let second_id = second.as_ref().map(|view| view.work_id.clone()).ok();
    h.record_debug("start_work second", &outcome(second));
    let blocked = progress(&[("announce", ActionStatus::Blocked)]);
    let revised = repo
        .replace_plan(plan_command(Plan {
            turn: "turn-3",
            call: "call-plan-2",
            objective: "Follow up",
            actions: vec![action("announce", "Announce it", &[])],
            progress: blocked.clone(),
            expected_work_id: second_id,
            opening_plan: false,
        }))
        .await;
    let plan = plan_state(&revised);
    h.record_debug("replace_plan second", &outcome(revised));
    let plan_review = repo
        .record_review(review_command(Review {
            turn: "turn-3",
            call: "call-review-2",
            subject: ReviewSubject::Plan,
            verdict: ReviewVerdict::Revise,
            summary: "Needs a date",
            corrections: vec!["Pick a date".into()],
            stages: [WorkStage::Planning, WorkStage::Review, WorkStage::Planning],
            plan,
            progress: blocked,
        }))
        .await;
    h.record_debug("record_review plan revise", &outcome(plan_review));
    let abandoned = repo.abandon_bound_work_for_turn("turn-3".into()).await;
    h.record_debug("abandon_bound_work_for_turn", &outcome(abandoned));
}

async fn dashboard(h: &mut Harness, work_id: &str, plan_id: &str) {
    let binding = ProjectLedgerBinding {
        app_project_id: APP_PROJECT.into(),
        ledger_project_id: LEDGER_PROJECT.into(),
    };
    let snapshot = h.ledger.dashboard_snapshot(binding.clone()).await;
    h.record_debug("dashboard_snapshot", &snapshot);
    let revision = snapshot
        .map(|snapshot| snapshot.revision)
        .unwrap_or_default();
    for (kind, id) in [("work", work_id), ("plan", plan_id)] {
        let source = h
            .ledger
            .read_dashboard_source(binding.clone(), kind.into(), id.into(), revision.clone())
            .await;
        h.record_debug(&format!("read_dashboard_source {kind}"), &source);
    }
    for filter in [None, Some(work_id.to_owned())] {
        let history = h
            .ledger
            .dashboard_work_history_for_revision(binding.clone(), revision.clone(), filter.clone())
            .await;
        h.record_debug(&format!("dashboard_work_history {filter:?}"), &history);
        let Ok(history) = history else { continue };
        for entry in history.iter().take(1) {
            let source = h
                .ledger
                .read_dashboard_source(
                    binding.clone(),
                    "reference".into(),
                    entry.id.clone(),
                    entry.revision.clone(),
                )
                .await;
            h.record_debug("read_dashboard_source reference", &source);
        }
    }
    let plan = h
        .ledger
        .read_project_work_plan(ProjectWorkPlanRead {
            app_project_id: APP_PROJECT.into(),
            ledger_project_id: LEDGER_PROJECT.into(),
            work_id: work_id.into(),
        })
        .await;
    h.record_debug("read_project_work_plan", &plan);
    let signals = h
        .ledger
        .briefing_signals(
            Some(vec![ProjectBriefingTarget {
                id: APP_PROJECT.into(),
                display_name: "Demo".into(),
                ledger_project_id: LEDGER_PROJECT.into(),
                recent_session_titles: Vec::new(),
            }]),
            h.data().join("consolidation"),
        )
        .await;
    h.record_debug("briefing_signals", &signals);
    let history = h
        .ledger
        .read_dashboard_ledger_history(LEDGER_PROJECT.into())
        .await;
    h.record_debug("read_dashboard_ledger_history", &history);
}
