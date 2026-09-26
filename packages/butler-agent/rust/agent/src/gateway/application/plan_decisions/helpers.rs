use rusqlite::{Connection, OptionalExtension};

use super::contracts::{AppPlanDecisionLedgerError, AppPlanDecisionPlan};
use crate::{
    gateway::application::{AppStorageError, read_model},
    public_text::trim_js_whitespace,
};

pub(super) struct DecisionProject {
    pub app_project_id: String,
    pub ledger_project_id: String,
}

pub(super) fn decision_project(
    db: &Connection,
    session_id: &str,
    plan_id: &str,
) -> Result<DecisionProject, AppStorageError> {
    let row = db
        .query_row(
            "SELECT c.project_id,p.ledger_project_id FROM chats c \
             LEFT JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| AppStorageError::new("session_not_found", "Session not found."))?;
    let app_project_id = row
        .0
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppStorageError::new(
                "plan_project_required",
                "Plan mode is available only in a project session.",
            )
        })?;
    let ledger_project_id = row
        .1
        .map(|value| trim_js_whitespace(&value).to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppStorageError::new(
                "project_ledger_identity_missing",
                "This project has no canonical Project Ledger identity.",
            )
        })?;
    if read_model::latest_plan_document_status(db, session_id, plan_id)?.as_deref() != Some("draft")
    {
        return Err(AppStorageError::new(
            "plan_not_awaiting_decision",
            "This Plan is not awaiting a decision in this session.",
        ));
    }
    Ok(DecisionProject {
        app_project_id,
        ledger_project_id,
    })
}

pub(super) fn map_decision_project_error(
    error: AppStorageError,
) -> crate::gateway::GatewayApplicationError {
    match error.code() {
        "plan_project_required"
        | "project_ledger_identity_missing"
        | "plan_not_awaiting_decision" => public(409, error.code(), error.detail()),
        _ => crate::gateway::application::app_error(error),
    }
}

pub(super) fn decision_gate(
    db: &Connection,
    session_id: &str,
    plan_id: &str,
) -> Result<(bool, bool), AppStorageError> {
    let latest: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT state,safe_error_code FROM turns WHERE chat_id=?1 ORDER BY rowid DESC LIMIT 1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let active = latest.is_some_and(|(state, safe_error)| {
        safe_error.as_deref() != Some("provider_round_timeout")
            && matches!(
                state.as_str(),
                "accepted"
                    | "thinking"
                    | "streaming"
                    | "waiting_for_form"
                    | "waiting_for_tool"
                    | "cancelling"
                    | "retrying"
            )
    });
    let pending = super::super::queue_view::list(db, session_id)?
        .queued_messages
        .iter()
        .any(|message| {
            matches!(&message.state, crate::gateway::QueueState::Queued)
                && message.plan_id.as_deref() == Some(plan_id)
        });
    Ok((active, pending))
}

pub(super) fn normalized_plan(
    plan: AppPlanDecisionPlan,
    expected_id: &str,
) -> Option<AppPlanDecisionPlan> {
    let id = trim_js_whitespace(&plan.id).to_owned();
    let title = trim_js_whitespace(&plan.title).to_owned();
    let body = trim_js_whitespace(&plan.body).to_owned();
    (id == expected_id && !title.is_empty() && !body.is_empty()).then(|| AppPlanDecisionPlan {
        id,
        title,
        status: {
            let status = trim_js_whitespace(&plan.status);
            if status.is_empty() { "draft" } else { status }
        }
        .to_owned(),
        body,
    })
}

pub(super) fn map_read_error(
    error: AppPlanDecisionLedgerError,
) -> crate::gateway::GatewayApplicationError {
    use crate::gateway::GatewayApplicationError;

    match error {
        AppPlanDecisionLedgerError::Changed => public(
            409,
            "plan_decision_conflict",
            "This Project Ledger Plan has changed.",
        ),
        AppPlanDecisionLedgerError::Unavailable => public(
            409,
            "project_ledger_resolution_failed",
            "The canonical Project Ledger for this project could not be resolved.",
        ),
        AppPlanDecisionLedgerError::Internal => GatewayApplicationError::Internal,
    }
}

fn public(status: u16, code: &str, message: &str) -> crate::gateway::GatewayApplicationError {
    crate::gateway::GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}
