use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::btcc::BtccError;
use crate::btcc::work::{
    ActionProgress, ActionStatus, Checkpoint, LegacyProjectWorkSourceSnapshot, ProjectWorkBinding,
    ProjectWorkLegacyCheckpoint, ProjectWorkLegacyInput, ProjectWorkLegacySnapshot,
    ProjectWorkLegacySourceKind, ProjectWorkLegacyTurn, WorkOrigin, WorkPlan, WorkScope,
    WorkStatus, WorkView,
};

use super::super::super::{StorageError, StorageResult, work::project_external_legacy_work};
use super::super::SqliteProjectWorkRuntime;
use super::{import_id, invalid, record_id, require_turn, source_hash, valid_hash};
use crate::btcc::BtccCode;
use crate::btcc::StorageCode;

pub(super) async fn capture(
    runtime: &SqliteProjectWorkRuntime,
    input: &ProjectWorkLegacyInput,
) -> Result<Option<ProjectWorkLegacySnapshot>, BtccError> {
    let ids = runtime
        .write({
            let input = input.clone();
            move |db, _| program_ids(db, &input)
        })
        .await?;
    if ids.is_empty() {
        return Ok(None);
    }
    let Some(source) = runtime
        .raw_r2_source
        .load_open_work(
            input
                .scope
                .project_ref
                .clone()
                .unwrap_or_else(|| input.resolved_scope.app_project_id.clone()),
            ids.clone(),
        )
        .await?
    else {
        return Ok(None);
    };
    let input = input.clone();
    runtime
        .write(move |db, _| {
            if stable_ids(&program_ids(db, &input)?) != stable_ids(&ids) {
                return Err(invalid(StorageCode::ProjectWorkLegacySourceChanged));
            }
            project(db, &input, &source, &ids).map(Some)
        })
        .await
}

pub(super) async fn revalidate(
    runtime: &SqliteProjectWorkRuntime,
    input: ProjectWorkLegacyInput,
    snapshot: std::sync::Arc<ProjectWorkLegacySnapshot>,
) -> Result<(), BtccError> {
    if snapshot.source_kind != ProjectWorkLegacySourceKind::RawR2 {
        return Ok(());
    }
    let ids = runtime
        .write({
            let input = input.clone();
            move |db, _| program_ids(db, &input)
        })
        .await?;
    if stable_ids(&ids) != stable_ids(&snapshot.source_program_ids)
        || !ids.contains(&snapshot.source_program_id)
    {
        return Err(BtccError::detected(
            BtccCode::ProjectWorkLegacySourceChanged,
            "project_work_legacy_source_changed",
        ));
    }
    let source = runtime
        .raw_r2_source
        .load_open_work(
            input
                .scope
                .project_ref
                .clone()
                .unwrap_or_else(|| input.resolved_scope.app_project_id.clone()),
            ids.clone(),
        )
        .await?;
    let Some(source) = source.filter(|v| v.source_program_id == snapshot.source_program_id) else {
        return Err(BtccError::detected(
            BtccCode::ProjectWorkLegacySourceChanged,
            "project_work_legacy_source_changed",
        ));
    };
    let recreated = runtime
        .write(move |db, _| project(db, &input, &source, &ids))
        .await?;
    if recreated.source_sha256 != snapshot.source_sha256
        || recreated.work.work_id != snapshot.work.work_id
    {
        return Err(BtccError::detected(
            BtccCode::ProjectWorkLegacySourceChanged,
            "project_work_legacy_source_changed",
        ));
    }
    Ok(())
}

pub(super) fn program_ids(
    db: &Connection,
    input: &ProjectWorkLegacyInput,
) -> StorageResult<Vec<String>> {
    require_turn(db, &input.scope)?;
    if input.scope.project_ref.as_deref().is_none_or(str::is_empty) {
        return Ok(Vec::new());
    }
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' \
         AND name IN ('btcc_turns','btcc_project_program_projections')",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::sqlite)?;
    if count != 2 {
        return Ok(Vec::new());
    }
    let mut query = db
        .prepare(
            "SELECT turn.managed_state_json FROM btcc_turns turn \
         WHERE turn.session_id=?1 AND turn.route='managed' ORDER BY turn.rowid DESC",
        )
        .map_err(StorageError::sqlite)?;
    let mut ids = HashSet::new();
    for row in query
        .query_map([&input.scope.session_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(StorageError::sqlite)?
    {
        let value = row.map_err(StorageError::sqlite)?;
        if let Some(program_id) = managed_program(value.as_deref()) {
            let present = db
                .query_row(
                    "SELECT 1 FROM btcc_project_program_projections WHERE program_id=?1 LIMIT 1",
                    [&program_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(StorageError::sqlite)?;
            if present.is_some() {
                ids.insert(program_id);
            }
        }
    }
    let mut sorted = ids.into_iter().collect::<Vec<_>>();
    sorted.sort();
    Ok(sorted)
}

fn project(
    db: &Connection,
    input: &ProjectWorkLegacyInput,
    source: &LegacyProjectWorkSourceSnapshot,
    program_ids: &[String],
) -> StorageResult<ProjectWorkLegacySnapshot> {
    if !valid_hash(&source.source_revision) {
        return Err(invalid(StorageCode::ProjectWorkLegacySourceRevisionInvalid));
    }
    let projection = project_external_legacy_work(source)?;
    let origin = origin_turn(
        db,
        &input.scope.session_id,
        &source.source_program_id,
        projection.original_message_id.as_deref(),
    )?
    .ok_or_else(|| invalid(StorageCode::ProjectWorkLegacyTurnOwnershipInvalid))?;
    if projection
        .original_message_id
        .as_ref()
        .is_some_and(|id| id != &origin.original_message_id)
    {
        return Err(invalid(StorageCode::ProjectWorkLegacyOriginMessageInvalid));
    }
    let import_id = import_id(
        &source.source_program_id,
        &input.scope.session_id,
        &input.resolved_scope.app_project_id,
    );
    let work_id = record_id("work", &import_id);
    let exists = db.query_row(
        "SELECT 1 FROM btcc_guided_work_legacy_imports WHERE import_id=?1 OR work_id=?2 \
         OR (legacy_program_id=?3 AND session_id=?4 AND scope_kind='project' AND scope_ref=?5) LIMIT 1",
        params![import_id,work_id,source.source_program_id,input.scope.session_id,input.resolved_scope.app_project_id],
        |row| row.get::<_, i64>(0),
    ).optional().map_err(StorageError::sqlite)?;
    if exists.is_some() {
        return Err(invalid(StorageCode::ProjectWorkLegacyIdentityConflict));
    }
    let plan_id = (!projection.actions.is_empty()).then(|| record_id("plan", &import_id));
    let checkpoint_id = projection
        .checkpoint
        .as_ref()
        .map(|_| record_id("checkpoint", &import_id));
    let at = "1970-01-01T00:00:00.000Z".to_owned();
    let plan = plan_id.as_ref().map(|id| WorkPlan {
        plan_revision_id: id.clone(),
        revision: 1,
        objective: projection.objective.clone(),
        governing_refs: Vec::new(),
        execution_mode: None,
        actions: projection.actions.clone(),
        checks: projection.checks.clone(),
        origin_turn_id: origin.turn_id.clone(),
        created_at: at.clone(),
    });
    let checkpoint = projection
        .checkpoint
        .as_ref()
        .zip(checkpoint_id.as_ref())
        .zip(plan.as_ref())
        .map(|((projected, id), plan)| Checkpoint {
            checkpoint_revision_id: id.clone(),
            revision: 1,
            plan_revision_id: plan.plan_revision_id.clone(),
            stage: projected.stage,
            action_progress: projected.actions.clone(),
            public_summary: projected.summary.clone(),
            next_step: projected.next.clone(),
            referenced_result_refs: Vec::new(),
            origin_turn_id: origin.turn_id.clone(),
            created_at: at.clone(),
        });
    let progress = checkpoint.as_ref().map_or_else(
        || {
            plan.as_ref().map_or_else(Vec::new, |plan| {
                plan.actions
                    .iter()
                    .map(|action| ActionProgress {
                        action_key: action.action_key.clone(),
                        status: ActionStatus::Pending,
                        note: None,
                    })
                    .collect()
            })
        },
        |checkpoint| checkpoint.action_progress.clone(),
    );
    let stage = checkpoint.as_ref().map(|checkpoint| checkpoint.stage);
    let work = WorkView {
        work_id: work_id.clone(),
        session_id: input.scope.session_id.clone(),
        scope: WorkScope::Project {
            project_ref: input.resolved_scope.app_project_id.clone(),
        },
        origin: WorkOrigin {
            turn_id: origin.turn_id.clone(),
            message_id: origin.original_message_id.clone(),
        },
        objective: projection.objective,
        status: WorkStatus::Open,
        current_stage: stage,
        allowed_next_stages: crate::btcc::work::policy::allowed_next_work_stages(stage),
        action_progress: progress,
        current_plan: plan.clone(),
        latest_checkpoint: checkpoint.clone(),
        latest_plan_review: None,
        latest_result_review: None,
        latest_completion_validation: None,
        latest_disposition: None,
        effect_watermark: Some(crate::btcc::identity::digest("[]")),
        effect_blockers: None,
        result_refs: Vec::new(),
        created_at: at.clone(),
        updated_at: at.clone(),
    };
    let binding = ProjectWorkBinding {
        binding_revision_id: record_id("binding", &format!("{}\0{}\0{work_id}", origin.turn_id, 1)),
        turn_id: origin.turn_id.clone(),
        revision: 1,
        bound_at: at,
        is_current: true,
    };
    let raw_source = json!({
        "sourceProgramId":source.source_program_id,"goalContract":source.goal_contract,
        "plan":source.plan,"works":source.works,"tasks":source.tasks,
        "referencedRecords":source.referenced_records,
    });
    let source_identity = format!("r2:{}:{work_id}", source.source_program_id);
    let checkpoints = checkpoint
        .map(|checkpoint| {
            vec![ProjectWorkLegacyCheckpoint {
                checkpoint,
                from_result_sequence: 0,
                to_result_sequence: 0,
            }]
        })
        .unwrap_or_default();
    let plans = plan.into_iter().collect::<Vec<_>>();
    let semantic = json!({
        "sourceProgramId":source.source_program_id,"sourceIdentity":source_identity,
        "rawSource":raw_source,"work":work,"plans":plans,"checkpoints":checkpoints,
        "reviews":[],"dispositions":[],"bindings":[binding.clone()],"turns":[origin.clone()],
    });
    Ok(ProjectWorkLegacySnapshot {
        source_kind: ProjectWorkLegacySourceKind::RawR2,
        source_program_id: source.source_program_id.clone(),
        source_program_ids: program_ids.to_vec(),
        source_identity,
        source_sha256: source_hash(&semantic)?,
        work,
        plans,
        checkpoints,
        reviews: Vec::new(),
        dispositions: Vec::new(),
        bindings: vec![binding],
        turns: vec![origin],
    })
}

fn origin_turn(
    db: &Connection,
    session_id: &str,
    program_id: &str,
    original_message_id: Option<&str>,
) -> StorageResult<Option<ProjectWorkLegacyTurn>> {
    let mut query = db
        .prepare(
            "SELECT turn_id,session_id,original_message_id,original_message,semantic_state, \
         execution_fence,managed_state_json FROM btcc_turns WHERE session_id=?1 ORDER BY rowid",
        )
        .map_err(StorageError::sqlite)?;
    let rows = query
        .query_map([session_id], |row| {
            Ok((
                ProjectWorkLegacyTurn {
                    turn_id: row.get(0)?,
                    session_id: row.get(1)?,
                    original_message_id: row.get(2)?,
                    original_message: row.get(3)?,
                    semantic_state: row.get(4)?,
                    execution_fence: row.get(5)?,
                },
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    Ok(original_message_id
        .and_then(|id| rows.iter().find(|(turn, _)| turn.original_message_id == id))
        .or_else(|| {
            rows.iter()
                .find(|(_, state)| managed_program(state.as_deref()).as_deref() == Some(program_id))
        })
        .map(|(turn, _)| turn.clone()))
}

fn managed_program(state: Option<&str>) -> Option<String> {
    let id = serde_json::from_str::<Value>(state?)
        .ok()?
        .get("programId")?
        .as_str()?
        .to_owned();
    (!id.is_empty()).then_some(id)
}
fn stable_ids(ids: &[String]) -> String {
    let mut ids = ids.to_vec();
    ids.sort();
    ids.join("\0")
}
