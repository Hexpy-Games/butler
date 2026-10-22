//! An untracked operation uses its Turn as journal scope, never a Plan allowlist.
use super::GuidedTools;
use butler_turn::btcc::{DurableWorkStatus as WorkStatus, WorkOrigin, WorkScope, WorkView};

pub(in crate::host::guided::tools) fn untracked(owner: &GuidedTools) -> WorkView {
    WorkView {
        work_id: format!("operation-turn:{}", owner.binding.turn_id),
        session_id: owner.binding.source_session_id.clone(),
        scope: WorkScope::Session {
            session_id: owner.binding.source_session_id.clone(),
        },
        origin: WorkOrigin {
            turn_id: owner.binding.turn_id.clone(),
            message_id: String::new(),
        },
        objective: String::new(),
        status: WorkStatus::Open,
        current_stage: None,
        allowed_next_stages: vec![],
        action_progress: vec![],
        current_plan: None,
        latest_checkpoint: None,
        latest_plan_review: None,
        latest_result_review: None,
        latest_completion_validation: None,
        latest_disposition: None,
        effect_watermark: None,
        effect_blockers: None,
        result_refs: vec![],
        created_at: String::new(),
        updated_at: String::new(),
    }
}

/// Effects share the new Work identity without reading or selecting legacy Work.
pub(in crate::host::guided::tools) async fn bound(
    owner: &GuidedTools,
) -> Result<WorkView, butler_turn::btcc::BtccError> {
    let session = owner.binding.source_session_id.clone();
    let row = owner
        .journal
        .work_model_storage()
        .work_model_read(move |db| butler_work::store::bound_work(db, &session, None))
        .await?;
    let mut work = untracked(owner);
    if let Some(row) = row {
        work.work_id = row["id"]
            .as_str()
            .ok_or_else(|| {
                butler_turn::btcc::BtccError::relayed("work_model_invalid", "Work id required")
            })?
            .to_owned();
        work.objective = row["title"].as_str().unwrap_or_default().to_owned();
        if row["scope_kind"] == "project" {
            work.scope = WorkScope::Project {
                project_ref: row["scope_ref"]
                    .as_str()
                    .ok_or_else(|| {
                        butler_turn::btcc::BtccError::relayed(
                            "work_model_invalid",
                            "Project scope required",
                        )
                    })?
                    .to_owned(),
            };
        }
    }
    Ok(work)
}
