use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{
    ActionProgress, ActionStatus, Checkpoint, DispositionStatus, EffectBlocker, ReviewSubject,
    ReviewVerdict, ToolResultRef, WorkDisposition, WorkOrigin, WorkPlan, WorkReview, WorkScope,
    WorkStage, WorkView,
};

use super::super::{StorageError, StorageResult, common};

const RESULT_ORDER: &str = "CASE WHEN result.source_turn_rowid IS NULL THEN 1 ELSE 0 END, result.source_turn_rowid, CASE WHEN result.source_turn_sequence IS NULL THEN 1 ELSE 0 END, result.source_turn_sequence, result.sequence, result.rowid";

pub(super) fn hydrate(db: &Connection, row: &common::WorkRow) -> StorageResult<WorkView> {
    let results = result_refs(db, &row.id)?;
    let plan = row
        .current_plan_revision_id
        .as_deref()
        .map(|id| plan(db, id))
        .transpose()?
        .flatten();
    let checkpoint = checkpoint(db, &row.id, plan.as_ref(), row.status.as_str())?;
    let checkpoint_matches_plan = plan
        .as_ref()
        .zip(checkpoint.as_ref())
        .is_some_and(|(p, c)| p.plan_revision_id == c.plan_revision_id);
    let default_progress: Vec<ActionProgress> = plan.as_ref().map_or_else(Vec::new, |p| {
        p.actions
            .iter()
            .map(|action| ActionProgress {
                action_key: action.action_key.clone(),
                status: if row.status == "completed" {
                    ActionStatus::Done
                } else {
                    ActionStatus::Pending
                },
                note: None,
            })
            .collect()
    });
    let action_progress = if checkpoint_matches_plan {
        checkpoint.as_ref().unwrap().action_progress.clone()
    } else {
        default_progress
    };
    let current_stage = if plan.is_some() {
        Some(if checkpoint_matches_plan {
            checkpoint.as_ref().unwrap().stage
        } else {
            WorkStage::Planning
        })
    } else {
        checkpoint.as_ref().map(|c| c.stage)
    };
    let effect_blockers = effect_blockers(db, &row.id)?;
    let effect_watermark = effect_watermark(db, &row.id)?;
    Ok(WorkView {
        work_id: row.id.clone(),
        session_id: row.session_id.clone(),
        scope: if row.scope_kind == "project" {
            WorkScope::Project {
                project_ref: row.scope_ref.clone(),
            }
        } else {
            WorkScope::Session {
                session_id: row.scope_ref.clone(),
            }
        },
        origin: WorkOrigin {
            turn_id: row.origin_turn_id.clone(),
            message_id: row.origin_message_id.clone(),
        },
        objective: row.objective.clone(),
        status: row.status()?,
        current_stage,
        allowed_next_stages: crate::btcc::work::policy::allowed_next_work_stages(current_stage),
        action_progress,
        current_plan: plan,
        latest_checkpoint: checkpoint,
        latest_plan_review: review(db, &row.id, ReviewSubject::Plan)?,
        latest_result_review: review(db, &row.id, ReviewSubject::Result)?,
        latest_completion_validation: review(db, &row.id, ReviewSubject::Completion)?,
        latest_disposition: disposition(db, &row.id)?,
        effect_watermark: Some(effect_watermark),
        effect_blockers: (!effect_blockers.is_empty()).then_some(effect_blockers),
        result_refs: results,
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
    })
}

fn plan(db: &Connection, id: &str) -> StorageResult<Option<WorkPlan>> {
    let row = db.query_row("SELECT plan_revision_id, revision, objective, governing_refs_json, execution_mode, actions_json, checks_json, origin_turn_id, created_at FROM btcc_guided_work_plan_revisions WHERE plan_revision_id = ?1", [id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?))
    }).optional().map_err(StorageError::sqlite)?;
    row.map(
        |(id, revision, objective, refs, mode, actions, checks, origin, created_at)| {
            Ok(WorkPlan {
                plan_revision_id: id,
                revision,
                objective,
                governing_refs: common::parse_json(&refs)?,
                execution_mode: mode.as_deref().map(common::parse_enum).transpose()?,
                actions: common::parse_json(&actions)?,
                checks: common::parse_json(&checks)?,
                origin_turn_id: origin,
                created_at,
            })
        },
    )
    .transpose()
}

fn checkpoint(
    db: &Connection,
    work_id: &str,
    plan: Option<&WorkPlan>,
    status: &str,
) -> StorageResult<Option<Checkpoint>> {
    let row = db.query_row("SELECT checkpoint_revision_id, revision, plan_revision_id, stage, public_summary, next_step, action_states_json, result_sequence, origin_turn_id, created_at FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?1 ORDER BY revision DESC LIMIT 1", [work_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, u64>(7)?, row.get::<_, String>(8)?, row.get::<_, String>(9)?))
    }).optional().map_err(StorageError::sqlite)?;
    let Some((
        id,
        revision,
        plan_id,
        stage,
        summary,
        next,
        states,
        result_sequence,
        origin,
        created_at,
    )) = row
    else {
        return Ok(None);
    };
    let prior: u64 = db.query_row("SELECT result_sequence FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ?1 AND revision < ?2 ORDER BY revision DESC LIMIT 1", params![work_id, revision], |row| row.get(0)).optional().map_err(StorageError::sqlite)?.unwrap_or(0);
    let refs = db.prepare("SELECT result_ref FROM btcc_guided_work_results WHERE work_id = ?1 AND sequence > ?2 AND sequence <= ?3 ORDER BY sequence")
        .map_err(StorageError::sqlite)?.query_map(params![work_id, prior, result_sequence], |row| row.get::<_, String>(0)).map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?;
    let inferred_plan_id = plan_id
        .or_else(|| {
            plan.filter(|plan| created_at >= plan.created_at)
                .map(|plan| plan.plan_revision_id.clone())
        })
        .unwrap_or_else(|| "legacy".into());
    let parsed: Vec<ActionProgress> = common::parse_json(&states)?;
    let action_progress = if parsed.is_empty() {
        plan.map_or_else(Vec::new, |p| {
            p.actions
                .iter()
                .map(|a| ActionProgress {
                    action_key: a.action_key.clone(),
                    status: if status == "completed" {
                        ActionStatus::Done
                    } else {
                        ActionStatus::Pending
                    },
                    note: None,
                })
                .collect()
        })
    } else {
        parsed
    };
    Ok(Some(Checkpoint {
        checkpoint_revision_id: id,
        revision,
        plan_revision_id: inferred_plan_id,
        stage: common::parse_enum(&stage)?,
        action_progress,
        public_summary: summary,
        next_step: next,
        referenced_result_refs: refs,
        origin_turn_id: origin,
        created_at,
    }))
}

fn review(
    db: &Connection,
    work_id: &str,
    subject: ReviewSubject,
) -> StorageResult<Option<WorkReview>> {
    let name = match subject {
        ReviewSubject::Plan => "plan",
        ReviewSubject::Result => "result",
        ReviewSubject::Completion => "completion",
    };
    let row = db.query_row("SELECT review_revision_id, revision, verdict, summary, corrections_json, bound_plan_revision_id, bound_result_sequence, bound_result_review_revision_id, bound_action_states_json, origin_turn_id, created_at FROM btcc_guided_work_review_revisions WHERE work_id = ?1 AND subject = ?2 ORDER BY revision DESC LIMIT 1", params![work_id, name], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<u64>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, String>(9)?, row.get::<_, String>(10)?))
    }).optional().map_err(StorageError::sqlite)?;
    let Some((
        id,
        revision,
        verdict,
        summary,
        corrections,
        plan_id,
        sequence,
        result_review_id,
        action_states,
        origin,
        created,
    )) = row
    else {
        return Ok(None);
    };
    let bound_result_refs = if let Some(sequence) = sequence {
        db.prepare("SELECT result_ref FROM btcc_guided_work_results WHERE work_id = ?1 AND sequence <= ?2 ORDER BY sequence").map_err(StorageError::sqlite)?
            .query_map(params![work_id, sequence], |row| row.get::<_, String>(0)).map_err(StorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?
    } else {
        vec![]
    };
    Ok(Some(WorkReview {
        review_revision_id: id,
        revision,
        subject,
        verdict: common::parse_enum::<ReviewVerdict>(&verdict)?,
        summary,
        corrections: common::parse_json(&corrections)?,
        bound_plan_revision_id: plan_id,
        bound_result_review_revision_id: result_review_id,
        bound_action_progress: action_states
            .map(|value| common::parse_json(&value))
            .transpose()?,
        bound_result_refs,
        origin_turn_id: origin,
        created_at: created,
    }))
}

pub(super) fn result_refs(db: &Connection, work_id: &str) -> StorageResult<Vec<ToolResultRef>> {
    let sql = format!(
        "SELECT result.result_ref, result.sequence, result.tool_call_id, call.tool_name, call.status, call.result_sha256, call.error_code, result.origin_turn_id, result.attached_at FROM btcc_guided_work_results result JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id WHERE result.work_id = ?1 ORDER BY {RESULT_ORDER}"
    );
    let mut statement = db.prepare(&sql).map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([work_id], |row| {
            Ok(ToolResultRef {
                result_ref: row.get(0)?,
                revision: Some(row.get(1)?),
                tool_call_id: row.get(2)?,
                tool_name: row.get(3)?,
                status: row.get(4)?,
                result_sha256: row.get(5)?,
                error_code: row.get(6)?,
                origin_turn_id: row.get(7)?,
                attached_at: row.get(8)?,
            })
        })
        .map_err(StorageError::sqlite)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)
}

fn disposition(db: &Connection, work_id: &str) -> StorageResult<Option<WorkDisposition>> {
    let row = db.query_row("SELECT disposition_revision_id, revision, result_sequence, material_fingerprint, runtime_owned_open, disposition, summary, action_updates_json, remaining_actions_json, next_condition, evidence_refs_json, evidence_snapshot_json, followups_json, origin_turn_id, created_at FROM btcc_guided_work_disposition_revisions WHERE work_id = ?1 ORDER BY revision DESC LIMIT 1", [work_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?, row.get::<_, u64>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?, row.get::<_, Option<String>>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?, row.get::<_, String>(12)?, row.get::<_, String>(13)?, row.get::<_, String>(14)?))
    }).optional().map_err(StorageError::sqlite)?;
    row.map(
        |(
            id,
            revision,
            result_sequence,
            fingerprint,
            runtime,
            disposition,
            summary,
            updates,
            remaining,
            next,
            refs,
            snapshot,
            followups,
            origin,
            created,
        )| {
            Ok(WorkDisposition {
                disposition_revision_id: id,
                revision,
                result_sequence,
                material_fingerprint: fingerprint,
                runtime_owned_open: runtime == 1,
                disposition: common::parse_enum::<DispositionStatus>(&disposition)?,
                summary,
                action_updates: common::parse_json(&updates)?,
                remaining_actions: common::parse_json(&remaining)?,
                next_condition: next.filter(|v| !v.is_empty()),
                evidence_refs: common::parse_json(&refs)?,
                evidence_snapshot: common::parse_json(&snapshot)?,
                followups: common::parse_json(&followups)?,
                origin_turn_id: origin,
                created_at: created,
            })
        },
    )
    .transpose()
}

fn effect_blockers(db: &Connection, work_id: &str) -> StorageResult<Vec<EffectBlocker>> {
    let mut statement = db.prepare("SELECT blocker_id, source_turn_id, capability, target, detail, created_at FROM btcc_guided_work_effect_blockers WHERE work_id = ?1 AND status = 'unresolved' ORDER BY created_at, blocker_id").map_err(StorageError::sqlite)?;
    statement
        .query_map([work_id], |row| {
            Ok(EffectBlocker {
                blocker_id: row.get(0)?,
                source_turn_id: row.get(1)?,
                capability: row.get(2)?,
                target: row.get(3)?,
                detail: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)
}

fn effect_watermark(db: &Connection, work_id: &str) -> StorageResult<String> {
    let mut statement = db.prepare("SELECT effect_id, receipt_id, status, journal_revision, updated_at FROM btcc_guided_effects WHERE work_id = ?1 ORDER BY effect_id").map_err(StorageError::sqlite)?;
    let rows = statement.query_map([work_id], |row| Ok(serde_json::json!({
        "effect_id": row.get::<_, String>(0)?, "receipt_id": row.get::<_, String>(1)?, "status": row.get::<_, String>(2)?, "journal_revision": row.get::<_, u64>(3)?, "updated_at": row.get::<_, String>(4)?
    }))).map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?;
    Ok(crate::btcc::identity::digest(&common::stable(&rows)?))
}
