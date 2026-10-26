//! Validate runtime settlement against committed delegation/result authority.
use super::super::{StorageError, StorageResult};
use crate::btcc::{
    DispositionCommand, DispositionStatus, ProjectWorkDispositionPreparation, StorageCode, WorkView,
};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn prepare(
    db: &Connection,
    command: &DispositionCommand,
    current: &WorkView,
    result: &str,
) -> StorageResult<ProjectWorkDispositionPreparation> {
    let row: Option<(String, String, String, String)> = db.query_row(
        "SELECT x.status,x.summary,x.acceptance_evidence_json,json_extract(d.packet_json,'$.parent_work_ref.plan_revision_id') FROM btcc_steward_results x JOIN btcc_subsession_delegations d USING(relation_id) JOIN btcc_session_relations r USING(relation_id) WHERE x.result_id=?1 AND r.parent_session_id=?2 AND x.child_turn_id=?3 AND json_extract(d.packet_json,'$.child_role')='steward' AND json_extract(d.packet_json,'$.parent_work_ref.work_id')=?4",
        params![result, command.input.scope.session_id, command.input.scope.turn_id, current.work_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional().map_err(StorageError::sqlite)?;
    let invalid = || {
        StorageError::new(
            StorageCode::ProjectWorkProgressInvalid,
            "Delegated result does not authorize this disposition",
        )
    };
    let Some((status, summary, evidence, plan)) = row else {
        return Err(invalid());
    };
    let expected = match status.as_str() {
        "success" | "completed" => DispositionStatus::Completed,
        "cancelled" | "abandoned" => DispositionStatus::Open,
        _ => DispositionStatus::Blocked,
    };
    let evidence: Vec<String> = serde_json::from_str(&evidence).map_err(|_| invalid())?;
    if command.input.work_id != current.work_id
        || command.input.disposition != expected
        || command.normalized_summary != butler_core::public_text::trim_js_whitespace(&summary)
        || command.evidence_refs != evidence
        || current
            .current_plan
            .as_ref()
            .is_none_or(|p| p.plan_revision_id != plan)
    {
        return Err(invalid());
    }
    let status = match expected {
        DispositionStatus::Completed => crate::btcc::ActionStatus::Done,
        DispositionStatus::Open => crate::btcc::ActionStatus::Skipped,
        DispositionStatus::Blocked => crate::btcc::ActionStatus::Blocked,
    };
    let action_progress = current
        .action_progress
        .iter()
        .map(|action| crate::btcc::ActionProgress {
            action_key: action.action_key.clone(),
            status,
            note: Some(summary.clone()),
        })
        .collect();
    Ok(ProjectWorkDispositionPreparation::Apply {
        action_progress,
        evidence_snapshot: evidence,
    })
}
