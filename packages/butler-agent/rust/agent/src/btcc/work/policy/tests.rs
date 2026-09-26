use super::*;
use crate::btcc::work::contracts::{
    Checkpoint, EffectBlocker, ToolResultRef, WorkOrigin, WorkPlan, WorkScope,
};

fn plan() -> WorkPlan {
    WorkPlan {
        plan_revision_id: "plan".into(),
        revision: 1,
        objective: "objective".into(),
        governing_refs: vec![],
        execution_mode: None,
        actions: vec![PlanAction {
            action_key: "a".into(),
            description: "action".into(),
            dependency_keys: vec![],
            effect: Some(serde_json::json!({"capability": "cap", "target": "target"})),
        }],
        checks: vec![],
        origin_turn_id: "turn".into(),
        created_at: "now".into(),
    }
}

fn view() -> WorkView {
    WorkView {
        work_id: "work".into(),
        session_id: "session".into(),
        scope: WorkScope::Session {
            session_id: "session".into(),
        },
        origin: WorkOrigin {
            turn_id: "turn".into(),
            message_id: "message".into(),
        },
        objective: "objective".into(),
        status: WorkStatus::Open,
        current_stage: Some(WorkStage::Planning),
        allowed_next_stages: vec![],
        action_progress: vec![ActionProgress {
            action_key: "a".into(),
            status: ActionStatus::Pending,
            note: None,
        }],
        current_plan: Some(plan()),
        latest_checkpoint: None,
        latest_plan_review: None,
        latest_result_review: None,
        latest_completion_validation: None,
        latest_disposition: None,
        effect_watermark: Some("watermark".into()),
        effect_blockers: None,
        result_refs: vec![],
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

#[test]
fn replacement_preserves_matching_progress_and_defaults_new_actions() {
    let actions = vec![
        PlanAction {
            action_key: "a".into(),
            ..plan().actions[0].clone()
        },
        PlanAction {
            action_key: "b".into(),
            ..plan().actions[0].clone()
        },
    ];
    let prior = vec![ActionProgress {
        action_key: "a".into(),
        status: ActionStatus::Done,
        note: Some("done".into()),
    }];
    assert_eq!(
        progress_for_replacement_plan(&actions, &prior),
        vec![
            prior[0].clone(),
            ActionProgress {
                action_key: "b".into(),
                status: ActionStatus::Pending,
                note: None
            }
        ]
    );
}

#[test]
fn action_updates_replace_only_current_plan_actions() {
    let mut work = view();
    let updates = vec![ActionProgress {
        action_key: "a".into(),
        status: ActionStatus::Done,
        note: Some("finished".into()),
    }];
    assert_eq!(apply_work_action_updates(&work, &updates).unwrap(), updates);
    let unknown = vec![ActionProgress {
        action_key: "missing".into(),
        status: ActionStatus::Done,
        note: None,
    }];
    assert_eq!(
        apply_work_action_updates(&work, &unknown)
            .unwrap_err()
            .message(),
        "Durable Work action is not in the current Plan: missing"
    );
    work.current_plan = None;
    assert_eq!(
        apply_work_action_updates(&work, &[]).unwrap_err().message(),
        "Durable Work progress requires a current Plan"
    );
}

#[test]
fn result_review_requires_unique_matching_result_references() {
    let mut work = view();
    work.current_stage = Some(WorkStage::Review);
    work.result_refs.push(ToolResultRef {
        result_ref: "r1".into(),
        revision: Some(1),
        tool_call_id: "call".into(),
        tool_name: "tool".into(),
        status: "completed".into(),
        result_sha256: None,
        error_code: None,
        origin_turn_id: "turn".into(),
        attached_at: "now".into(),
    });
    work.latest_result_review = Some(WorkReview {
        review_revision_id: "review".into(),
        revision: 1,
        subject: ReviewSubject::Result,
        verdict: ReviewVerdict::Accept,
        summary: "ok".into(),
        corrections: vec![],
        bound_plan_revision_id: Some("plan".into()),
        bound_result_review_revision_id: None,
        bound_action_progress: None,
        bound_result_refs: vec!["r1".into()],
        origin_turn_id: "turn".into(),
        created_at: "now".into(),
    });
    assert!(accepted_current_result_review(&work).is_some());
    work.result_refs[0].result_ref = "r2".into();
    assert!(accepted_current_result_review(&work).is_none());
}

#[test]
fn review_transitions_follow_source_entry_and_target_stages() {
    assert_eq!(
        resolve_work_review_transition(
            WorkStage::Planning,
            ReviewSubject::Plan,
            ReviewVerdict::Accept,
            None
        )
        .unwrap(),
        (WorkStage::Review, WorkStage::Execution)
    );
    assert_eq!(
        resolve_work_review_transition(
            WorkStage::Execution,
            ReviewSubject::Result,
            ReviewVerdict::Revise,
            Some(CorrectionScope::Planning)
        )
        .unwrap(),
        (WorkStage::Review, WorkStage::Planning)
    );
    let error = resolve_work_review_transition(
        WorkStage::Execution,
        ReviewSubject::Result,
        ReviewVerdict::Revise,
        None,
    )
    .unwrap_err();
    assert_eq!(
        error.message(),
        "Work cannot result_review_revise from execution; correction_scope_required. Next action: choose_planning_or_execution_correction"
    );
}

#[test]
fn fingerprint_changes_when_blockers_or_checkpoint_change() {
    let work = view();
    let first = disposition_material_fingerprint(&work).unwrap();
    let mut changed = work.clone();
    changed.effect_blockers = Some(vec![EffectBlocker {
        blocker_id: "b".into(),
        source_turn_id: "turn".into(),
        capability: "cap".into(),
        target: "target".into(),
        detail: "pending".into(),
        created_at: "now".into(),
    }]);
    assert_ne!(first, disposition_material_fingerprint(&changed).unwrap());
    changed.latest_checkpoint = Some(Checkpoint {
        checkpoint_revision_id: "checkpoint".into(),
        revision: 1,
        plan_revision_id: "plan".into(),
        stage: WorkStage::Planning,
        action_progress: work.action_progress.clone(),
        public_summary: "summary".into(),
        next_step: "next".into(),
        referenced_result_refs: vec![],
        origin_turn_id: "turn".into(),
        created_at: "now".into(),
    });
    assert_ne!(first, disposition_material_fingerprint(&changed).unwrap());
}
