//! Runtime-derived parent Plan, inside the delegation writer transaction.
use super::{StorageError, StorageResult, common, mutation, read, relation};
use crate::btcc::{
    ExecutionMode, PlanAction, ReplacePlanCommand, ReplacePlanInput, WorkTurnScope, WorkView,
};
use rusqlite::Connection;

pub(in crate::btcc::storage) fn prepare(
    db: &Connection,
    scope: WorkTurnScope,
    call_id: &str,
    objective: String,
    (checks, governing_refs): (Vec<String>, Vec<String>),
    reuse_reviewed: bool,
    now: &str,
) -> StorageResult<WorkView> {
    let clock = || now.to_owned();
    let turn = common::relation_turn(db, &scope)?;
    let bound = common::bound(db, &scope.turn_id)?;
    let continuing = if let Some(work) = &bound {
        let active: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.parent_session_id=?2 AND json_extract(d.packet_json,'$.parent_work_ref.work_id')=?1 AND json_extract(d.packet_json,'$.child_role')='steward' AND NOT EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=r.relation_id))",
            rusqlite::params![work.id,scope.session_id], |row| row.get(0),
        ).map_err(StorageError::sqlite)?;
        work.is_open() && !active
    } else {
        false
    };
    let work = if let Some(work) = bound.filter(|_| continuing) {
        let view = read::view(db, &work.id)?;
        if reuse_reviewed && accepted(&view) {
            return Ok(view);
        }
        work
    } else {
        // Switching the current binding preserves earlier Work and its active owner.
        relation::create_and_bind(db, &scope, call_id, &objective, &turn, &clock)?
    };
    let input = ReplacePlanInput {
        scope,
        mutation_call_id: format!("{call_id}:plan"),
        start_new: None,
        backfill_tool_call_ids: None,
        objective: objective.clone(),
        governing_refs: Some(governing_refs.clone()),
        execution_mode: Some(ExecutionMode::Steward),
        actions: vec![PlanAction {
            action_key: "delegated-objective".into(),
            description: objective,
            dependency_keys: vec![],
            effect: None,
        }],
        checks,
    };
    let identity = common::stable(&input)?;
    let command = ReplacePlanCommand {
        action_progress: crate::btcc::work::policy::progress_for_replacement_plan(
            &input.actions,
            &[],
        ),
        input,
        request_sha256: crate::btcc::digest_identity(&identity),
        start_new: false,
        governing_refs,
        expected_work_id: Some(work.id),
        expected_progress_revision: None,
        opening_plan: work.current_plan_revision_id.is_none(),
    };
    mutation::replace_plan(db, &command, &clock)
}

fn accepted(view: &WorkView) -> bool {
    view.current_plan.as_ref().is_some_and(|plan| {
        plan.execution_mode == Some(ExecutionMode::Steward)
            && view.latest_plan_review.as_ref().is_some_and(|review| {
                review.verdict == crate::btcc::ReviewVerdict::Accept
                    && review.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
            })
    })
}

pub(in crate::btcc::storage) fn legacy_parent(
    db: &Connection,
    turn: &str,
) -> StorageResult<Option<WorkView>> {
    let Some(row) = common::bound(db, turn)? else {
        return Ok(None);
    };
    let view = read::view(db, &row.id)?;
    Ok(accepted(&view).then_some(view))
}
