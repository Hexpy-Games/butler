use rusqlite::{Connection, OptionalExtension, params};

use crate::btcc::work::{
    ActionProgress, ActionStatus, Checkpoint, DispositionStatus, ProjectWorkLegacyCheckpoint,
    ProjectWorkLegacyDisposition, ReviewSubject, ReviewVerdict, WorkDisposition, WorkPlan,
    WorkReview, WorkStatus, WorkView,
};

use super::super::super::super::{StorageError, StorageResult};
use super::super::invalid;
use crate::btcc::StorageCode;

fn parse<T: serde::de::DeserializeOwned>(raw: &str) -> StorageResult<T> {
    serde_json::from_str(raw)
        .map_err(|source| invalid(StorageCode::ProjectWorkLegacyHistoryInvalid).with_source(source))
}
fn enum_parse<T: serde::de::DeserializeOwned>(raw: &str) -> StorageResult<T> {
    serde_json::from_value(serde_json::Value::String(raw.into()))
        .map_err(|source| invalid(StorageCode::ProjectWorkLegacyHistoryInvalid).with_source(source))
}
fn refs(db: &Connection, work_id: &str, through: u64) -> StorageResult<Vec<String>> {
    db.prepare("SELECT result_ref FROM btcc_guided_work_results WHERE work_id=?1 AND sequence<=?2 ORDER BY sequence")
        .map_err(StorageError::sqlite)?
        .query_map(params![work_id, through], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)
}

pub(super) fn plans(db: &Connection, work_id: &str) -> StorageResult<Vec<WorkPlan>> {
    let mut statement = db
        .prepare(
            "SELECT plan_revision_id,revision,objective,governing_refs_json,execution_mode, \
         actions_json,checks_json,origin_turn_id,created_at FROM btcc_guided_work_plan_revisions \
         WHERE work_id=?1 ORDER BY revision",
        )
        .map_err(StorageError::sqlite)?;
    statement
        .query_map([work_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .map(|row| {
            let (id, revision, objective, refs, mode, actions, checks, origin, at) =
                row.map_err(StorageError::sqlite)?;
            Ok(WorkPlan {
                plan_revision_id: id,
                revision,
                objective,
                governing_refs: parse(&refs)?,
                execution_mode: mode.as_deref().map(enum_parse).transpose()?,
                actions: parse(&actions)?,
                checks: parse(&checks)?,
                origin_turn_id: origin,
                created_at: at,
            })
        })
        .collect()
}

pub(super) fn checkpoints(
    db: &Connection,
    work_id: &str,
    plans: &[WorkPlan],
) -> StorageResult<Vec<ProjectWorkLegacyCheckpoint>> {
    let mut statement = db.prepare(
        "SELECT checkpoint_revision_id,revision,plan_revision_id,stage,public_summary,next_step, \
         action_states_json,result_sequence,origin_turn_id,created_at \
         FROM btcc_guided_work_checkpoint_revisions WHERE work_id=?1 ORDER BY revision",
    ).map_err(StorageError::sqlite)?;
    statement
        .query_map([work_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, u64>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .map(|row| {
            let (id, revision, plan_id, stage, summary, next, states, sequence, origin, at) =
                row.map_err(StorageError::sqlite)?;
            let plan = plans
                .iter()
                .find(|plan| plan.plan_revision_id == plan_id)
                .ok_or_else(|| invalid(StorageCode::ProjectWorkLegacyPlanMissing))?;
            let mut action_progress: Vec<ActionProgress> = parse(&states)?;
            if action_progress.is_empty() {
                action_progress = plan
                    .actions
                    .iter()
                    .map(|action| ActionProgress {
                        action_key: action.action_key.clone(),
                        status: ActionStatus::Pending,
                        note: None,
                    })
                    .collect();
            }
            Ok(ProjectWorkLegacyCheckpoint {
                from_result_sequence: 0,
                to_result_sequence: sequence,
                checkpoint: Checkpoint {
                    checkpoint_revision_id: id,
                    revision,
                    plan_revision_id: plan_id,
                    stage: enum_parse(&stage)?,
                    action_progress,
                    public_summary: summary,
                    next_step: next,
                    referenced_result_refs: refs(db, work_id, sequence)?,
                    origin_turn_id: origin,
                    created_at: at,
                },
            })
        })
        .collect()
}

pub(super) fn reviews(
    db: &Connection,
    work_id: &str,
    checkpoints: &[ProjectWorkLegacyCheckpoint],
    map_result_action_progress: bool,
) -> StorageResult<Vec<WorkReview>> {
    let mut statement = db
        .prepare(
            "SELECT review_revision_id,revision,subject,verdict,summary,corrections_json, \
         bound_plan_revision_id,bound_result_sequence,bound_result_review_revision_id, \
         bound_action_states_json,origin_turn_id,created_at \
         FROM btcc_guided_work_review_revisions WHERE work_id=?1 ORDER BY revision",
        )
        .map_err(StorageError::sqlite)?;
    statement
        .query_map([work_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<u64>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .map(|row| {
            let (
                id,
                revision,
                subject,
                verdict,
                summary,
                corrections,
                plan_id,
                sequence,
                result_review_id,
                states,
                origin,
                at,
            ) = row.map_err(StorageError::sqlite)?;
            let bound_action_progress = match states {
                Some(states) => Some(parse(&states)?),
                None if map_result_action_progress && subject == "result" => checkpoints
                    .iter()
                    .rev()
                    .find(|item| item.checkpoint.created_at <= at)
                    .map(|item| item.checkpoint.action_progress.clone()),
                None => None,
            };
            Ok(WorkReview {
                review_revision_id: id,
                revision,
                subject: enum_parse::<ReviewSubject>(&subject)?,
                verdict: enum_parse::<ReviewVerdict>(&verdict)?,
                summary,
                corrections: parse(&corrections)?,
                bound_plan_revision_id: plan_id,
                bound_result_review_revision_id: result_review_id,
                bound_action_progress,
                bound_result_refs: sequence
                    .map(|n| refs(db, work_id, n))
                    .transpose()?
                    .unwrap_or_default(),
                origin_turn_id: origin,
                created_at: at,
            })
        })
        .collect()
}

pub(super) fn dispositions(
    db: &Connection,
    work: &WorkView,
    plans: &[WorkPlan],
    checkpoints: &[ProjectWorkLegacyCheckpoint],
    reviews: &[WorkReview],
) -> StorageResult<Vec<ProjectWorkLegacyDisposition>> {
    let mut statement = db.prepare(
        "SELECT disposition_revision_id,revision,result_sequence,material_fingerprint, \
         runtime_owned_open,disposition,summary,action_updates_json,remaining_actions_json, \
         next_condition,evidence_refs_json,evidence_snapshot_json,followups_json,origin_turn_id,created_at \
         FROM btcc_guided_work_disposition_revisions WHERE work_id=?1 ORDER BY revision",
    ).map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([&work.work_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    for table in ["btcc_guided_effects", "btcc_guided_work_effect_blockers"] {
        let sql = format!("SELECT 1 FROM {table} WHERE work_id=?1 LIMIT 1");
        if db
            .query_row(&sql, [&work.work_id], |row| row.get::<_, i64>(0))
            .optional()
            .map_err(StorageError::sqlite)?
            .is_some()
        {
            return Err(invalid(
                StorageCode::ProjectWorkLegacyDispositionEffectHistoryUnavailable,
            ));
        }
    }
    let watermark = crate::btcc::identity::digest("[]");
    rows.into_iter()
        .map(|row| {
            let (
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
                evidence_refs,
                evidence_snapshot,
                followups,
                origin,
                at,
            ) = row;
            let disposition = WorkDisposition {
                disposition_revision_id: id,
                revision,
                result_sequence,
                material_fingerprint: fingerprint,
                runtime_owned_open: runtime == 1,
                disposition: enum_parse(&disposition)?,
                summary,
                action_updates: parse(&updates)?,
                remaining_actions: parse(&remaining)?,
                next_condition: next,
                evidence_refs: parse(&evidence_refs)?,
                evidence_snapshot: parse(&evidence_snapshot)?,
                followups: parse(&followups)?,
                origin_turn_id: origin,
                created_at: at.clone(),
            };
            let plan = plans.iter().rev().find(|plan| plan.created_at <= at);
            let checkpoint = checkpoints
                .iter()
                .rev()
                .find(|item| item.checkpoint.created_at <= at);
            let checkpoint_index = checkpoint.and_then(|item| {
                checkpoints.iter().position(|v| {
                    v.checkpoint.checkpoint_revision_id == item.checkpoint.checkpoint_revision_id
                })
            });
            let prior_sequence = checkpoint_index
                .filter(|index| *index > 0)
                .map_or(0, |index| {
                    usize::try_from(checkpoints[index - 1].to_result_sequence).unwrap_or(usize::MAX)
                });
            let latest_checkpoint = checkpoint.map(|item| {
                let mut value = item.checkpoint.clone();
                value.referenced_result_refs = work
                    .result_refs
                    .get(
                        prior_sequence
                            ..usize::try_from(item.to_result_sequence).unwrap_or(usize::MAX),
                    )
                    .unwrap_or(&[])
                    .iter()
                    .map(|v| v.result_ref.clone())
                    .collect();
                value
            });
            let result_refs = work
                .result_refs
                .get(..usize::try_from(result_sequence).unwrap_or(usize::MAX))
                .filter(|refs| refs.len() == usize::try_from(result_sequence).unwrap_or(usize::MAX))
                .ok_or_else(|| invalid(StorageCode::ProjectWorkLegacyDispositionResultMissing))?
                .to_vec();
            let review = |subject| {
                reviews
                    .iter()
                    .rev()
                    .find(|review| review.subject == subject && review.created_at <= at)
                    .cloned()
            };
            let mut historical = work.clone();
            historical.objective =
                plan.map_or_else(|| work.objective.clone(), |plan| plan.objective.clone());
            historical.status = match disposition.disposition {
                DispositionStatus::Completed => WorkStatus::Completed,
                DispositionStatus::Open => WorkStatus::Open,
                DispositionStatus::Blocked => WorkStatus::Blocked,
            };
            historical.current_plan = plan.cloned();
            historical.current_stage = latest_checkpoint.as_ref().map(|v| v.stage);
            historical.allowed_next_stages =
                crate::btcc::work::policy::allowed_next_work_stages(historical.current_stage);
            historical.action_progress = latest_checkpoint.as_ref().map_or_else(
                || {
                    plan.map_or_else(Vec::new, |plan| {
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
                |value| value.action_progress.clone(),
            );
            historical.latest_checkpoint = latest_checkpoint;
            historical.latest_plan_review = review(ReviewSubject::Plan);
            historical.latest_result_review = review(ReviewSubject::Result);
            historical.latest_completion_validation = review(ReviewSubject::Completion);
            historical.latest_disposition = None;
            historical.result_refs = result_refs;
            historical.effect_watermark = Some(watermark.clone());
            historical.effect_blockers = Some(Vec::new());
            historical.updated_at = at;
            let actual = crate::btcc::work::policy::disposition_material_fingerprint(&historical)
                .map_err(|source| {
                invalid(StorageCode::ProjectWorkLegacyDispositionMaterialMismatch)
                    .with_source(source)
            })?;
            if actual != disposition.material_fingerprint {
                return Err(invalid(
                    StorageCode::ProjectWorkLegacyDispositionMaterialMismatch,
                ));
            }
            Ok(ProjectWorkLegacyDisposition {
                disposition,
                historical_view: historical,
                effect_watermark: watermark.clone(),
            })
        })
        .collect()
}
