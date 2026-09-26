use rusqlite::{Connection, params};
use serde_json::json;

use crate::btcc::work::{
    ProjectWorkCapturedMaterial, ProjectWorkMaterialAction, ProjectWorkMaterialBlocker,
    ProjectWorkMaterialCheckpoint, ProjectWorkMaterialInput, ProjectWorkMaterialPlan,
    ProjectWorkMaterialProgress, ProjectWorkMaterialResultRef, ProjectWorkMaterialReview,
    ProjectWorkMaterialSnapshot, WorkView,
};

use super::super::{StorageError, StorageResult};

fn invalid(code: &'static str) -> StorageError {
    StorageError::new(code, code)
}

pub(super) fn capture(
    db: &Connection,
    input: &ProjectWorkMaterialInput,
) -> StorageResult<ProjectWorkCapturedMaterial> {
    let work = &input.candidate;
    let material_fingerprint = crate::btcc::work::policy::disposition_material_fingerprint(work)
        .map_err(|e| StorageError::new("project_work_material_invalid", e.message))?;
    let mut statement = db.prepare(
        "SELECT effect_id,receipt_id,status,journal_revision,updated_at FROM btcc_guided_effects \
         WHERE work_id=?1 ORDER BY effect_id",
    ).map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([&work.work_id], |row| {
            Ok(json!({
                "effect_id": row.get::<_, String>(0)?,
                "receipt_id": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "journal_revision": row.get::<_, u64>(3)?,
                "updated_at": row.get::<_, String>(4)?,
            }))
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    let effect_watermark = crate::btcc::identity::digest(
        &crate::btcc::identity::sqlite_stable_json(&serde_json::Value::Array(rows))
            .map_err(|e| StorageError::new("project_work_material_invalid", e.message))?,
    );
    let mut blockers_statement = db
        .prepare(
            "SELECT blocker_id,source_turn_id,capability,target,detail \
         FROM btcc_guided_work_effect_blockers WHERE work_id=?1 AND status='unresolved' \
         ORDER BY created_at,blocker_id",
        )
        .map_err(StorageError::sqlite)?;
    let effect_blockers = blockers_statement
        .query_map(params![work.work_id], |row| {
            Ok(ProjectWorkMaterialBlocker {
                blocker_id: row.get(0)?,
                source_turn_id: row.get(1)?,
                capability_sha256: crate::btcc::identity::digest(&row.get::<_, String>(2)?),
                target_sha256: crate::btcc::identity::digest(&row.get::<_, String>(3)?),
                detail_sha256: crate::btcc::identity::digest(&row.get::<_, String>(4)?),
            })
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    let snapshot = snapshot(
        work,
        material_fingerprint.clone(),
        Some(effect_watermark),
        effect_blockers,
    )?;
    Ok(ProjectWorkCapturedMaterial {
        material_fingerprint,
        material_snapshot: snapshot,
    })
}

pub(in crate::btcc) fn snapshot(
    work: &WorkView,
    material_fingerprint: String,
    effect_watermark: Option<String>,
    effect_blockers: Vec<ProjectWorkMaterialBlocker>,
) -> StorageResult<ProjectWorkMaterialSnapshot> {
    let progress = |items: &[crate::btcc::work::ActionProgress]| -> StorageResult<Vec<_>> {
        items
            .iter()
            .map(|item| {
                Ok(ProjectWorkMaterialProgress {
                    action_key: item.action_key.clone(),
                    status: enum_text(item.status)?,
                    note: item.note.clone(),
                })
            })
            .collect()
    };
    let current_plan = work
        .current_plan
        .as_ref()
        .map(|plan| -> StorageResult<_> {
            Ok(ProjectWorkMaterialPlan {
                plan_revision_id: plan.plan_revision_id.clone(),
                revision: plan.revision,
                objective: plan.objective.clone(),
                governing_refs: plan.governing_refs.clone(),
                execution_mode: plan.execution_mode.map(enum_text).transpose()?,
                actions: plan
                    .actions
                    .iter()
                    .map(|action| ProjectWorkMaterialAction {
                        action_key: action.action_key.clone(),
                        description: action.description.clone(),
                        dependency_keys: action.dependency_keys.clone(),
                        effect: action.effect.clone(),
                    })
                    .collect(),
                checks: plan.checks.clone(),
                origin_turn_id: plan.origin_turn_id.clone(),
                created_at: plan.created_at.clone(),
            })
        })
        .transpose()?;
    let latest_checkpoint = work
        .latest_checkpoint
        .as_ref()
        .map(|checkpoint| -> StorageResult<_> {
            Ok(ProjectWorkMaterialCheckpoint {
                revision: checkpoint.revision,
                plan_revision_id: checkpoint.plan_revision_id.clone(),
                stage: enum_text(checkpoint.stage)?,
                action_progress: progress(&checkpoint.action_progress)?,
                result_sequence: checkpoint.referenced_result_refs.len(),
                referenced_result_refs: checkpoint.referenced_result_refs.clone(),
            })
        })
        .transpose()?;
    let reviews = [
        work.latest_plan_review.as_ref(),
        work.latest_result_review.as_ref(),
        work.latest_completion_validation.as_ref(),
    ]
    .into_iter()
    .map(|review| {
        review
            .map(|review| -> StorageResult<_> {
                Ok(ProjectWorkMaterialReview {
                    review_revision_id: review.review_revision_id.clone(),
                    revision: review.revision,
                    verdict: enum_text(review.verdict)?,
                    bound_plan_revision_id: review.bound_plan_revision_id.clone(),
                    bound_result_review_revision_id: review.bound_result_review_revision_id.clone(),
                    bound_action_progress: review
                        .bound_action_progress
                        .as_ref()
                        .map(|items| progress(items))
                        .transpose()?,
                    bound_result_refs: review.bound_result_refs.clone(),
                })
            })
            .transpose()
    })
    .collect::<StorageResult<Vec<_>>>()?;
    Ok(ProjectWorkMaterialSnapshot {
        material_fingerprint,
        work_id: work.work_id.clone(),
        status: work.status,
        current_plan,
        action_progress: progress(&work.action_progress)?,
        latest_checkpoint,
        reviews,
        result_refs: work
            .result_refs
            .iter()
            .map(|result| ProjectWorkMaterialResultRef {
                result_ref: result.result_ref.clone(),
                tool_call_id: result.tool_call_id.clone(),
                status: result.status.clone(),
                origin_turn_id: result.origin_turn_id.clone(),
            })
            .collect(),
        effect_watermark,
        effect_blockers,
    })
}

fn enum_text<T: serde::Serialize>(value: T) -> StorageResult<String> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| invalid("project_work_material_invalid"))
}
