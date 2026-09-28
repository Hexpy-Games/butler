use super::*;

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
