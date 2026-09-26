use rusqlite::params;
use serde_json::{Map, Value, json};

use super::{
    AutomationDetail, AutomationDetailView, AutomationListView, AutomationMutationResult,
    AutomationRunListView, AutomationSummary, CreateAutomationRequest, UpdateAutomationRequest,
    records,
};
use crate::gateway::application::{
    AppApplication, AppStorageError, GatewayApplicationError, app_error, events, public,
};

const MIN_INTERVAL: i64 = 300;
const MAX_INTERVAL: i64 = 86_400;

impl AppApplication {
    pub(crate) async fn list_automations_owned(
        &self,
        target_session_id: Option<String>,
    ) -> Result<AutomationListView, GatewayApplicationError> {
        self.storage
            .execute(move |db| {
                Ok(AutomationListView {
                    automations: records::list(db, target_session_id.as_deref())?
                        .into_iter()
                        .map(records::summary)
                        .collect(),
                })
            })
            .await
            .map_err(app_error)
    }

    pub(crate) async fn get_automation_owned(
        &self,
        id: String,
    ) -> Result<AutomationDetailView, GatewayApplicationError> {
        self.storage
            .execute(move |db| {
                Ok(AutomationDetailView {
                    automation: detail(records::active(db, &id)?),
                })
            })
            .await
            .map_err(app_error)
    }

    pub(crate) async fn create_automation_owned(
        &self,
        input: CreateAutomationRequest,
    ) -> Result<AutomationMutationResult, GatewayApplicationError> {
        let title = required(
            &input.title,
            "automation_title_required",
            "Automation title is required.",
        )?;
        let prompt = required(
            &input.prompt_body,
            "automation_prompt_required",
            "Automation prompt is required.",
        )?;
        validate_interval(input.interval_seconds)?;
        let id = format!("automation-{}", self.dependencies.identity_clock.new_uuid());
        let now = self.dependencies.identity_clock.now_iso();
        let next = self
            .dependencies
            .identity_clock
            .iso_after_millis(input.interval_seconds as u64 * 1000);
        let subscribers = self.subscribers.clone();
        self.storage.execute(move |db| {
            let (kind, _) = records::target(db, input.target_session_id.trim())?;
            db.execute(
                "INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,state,next_run_at,last_run_at,last_run_state,last_safe_error_code,run_count,consecutive_failure_count,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'enabled',?7,NULL,'never_run',NULL,0,0,?8,?8)",
                params![id,title,prompt,kind,input.target_session_id.trim(),input.interval_seconds,next,now],
            ).map_err(AppStorageError::sqlite)?;
            let automation = detail(records::active(db, &id)?);
            publish(db, &subscribers, "automation.created", &json!({"automation":automation.summary}), &now)?;
            Ok(AutomationMutationResult { automation: serde_json::to_value(automation).map_err(json_error)? })
        }).await.map_err(app_error)
    }

    pub(crate) async fn update_automation_owned(
        &self,
        id: String,
        input: UpdateAutomationRequest,
    ) -> Result<AutomationMutationResult, GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move |db| {
            let old = records::active(db, &id)?;
            let title = nonempty(input.title).unwrap_or(old.title);
            let prompt = nonempty(input.prompt_body).unwrap_or(old.prompt);
            let target_id = nonempty(input.target_session_id).unwrap_or(old.target_id);
            let (kind, _) = records::target(db, &target_id)?;
            let seconds = input.interval_seconds.unwrap_or(old.interval);
            validate_interval_row(seconds)?;
            let state = input.state.unwrap_or(old.state);
            if state != "enabled" && state != "paused" {
                return Err(AppStorageError::new("automation_state_invalid", "Automation state must be enabled or paused."));
            }
            let next = if state == "enabled" { Some(clock.iso_after_millis(seconds as u64 * 1000)) } else { old.next };
            db.execute(
                "UPDATE app_automations SET title=?1,prompt_body=?2,target_kind=?3,target_session_id=?4,interval_seconds=?5,state=?6,next_run_at=?7,updated_at=?8 WHERE id=?9",
                params![title,prompt,kind,target_id,seconds,state,next,now,id],
            ).map_err(AppStorageError::sqlite)?;
            let automation = detail(records::active(db, &id)?);
            publish(db, &subscribers, "automation.updated", &json!({"automation":automation.summary}), &now)?;
            Ok(AutomationMutationResult { automation: serde_json::to_value(automation).map_err(json_error)? })
        }).await.map_err(app_error)
    }

    pub(crate) async fn delete_automation_owned(
        &self,
        id: String,
    ) -> Result<AutomationMutationResult, GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move |db| {
            let mut row = records::get(db, &id)?.ok_or_else(records::not_found)?;
            row.state = "deleted".into(); row.next = None; row.updated = now.clone();
            db.execute("UPDATE app_automations SET state='deleted',next_run_at=NULL,updated_at=?1 WHERE id=?2", params![now,id]).map_err(AppStorageError::sqlite)?;
            let automation = records::summary(row);
            publish(db, &subscribers, "automation.deleted", &json!({"automation":automation}), &now)?;
            Ok(AutomationMutationResult { automation: serde_json::to_value(automation).map_err(json_error)? })
        }).await.map_err(app_error)
    }

    pub(crate) async fn list_automation_runs_owned(
        &self,
        id: String,
    ) -> Result<AutomationRunListView, GatewayApplicationError> {
        self.storage
            .execute(move |db| {
                Ok(AutomationRunListView {
                    runs: records::runs(db, &id)?,
                })
            })
            .await
            .map_err(app_error)
    }

    pub(crate) async fn automation_targets(
        &self,
        session_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        self.storage
            .execute(move |db| {
                let targets = records::list(db, Some(&session_id))?
                    .into_iter()
                    .map(records::summary)
                    .map(target_summary)
                    .collect::<Vec<_>>();
                serde_json::to_value(targets).map_err(json_error)
            })
            .await
            .map_err(app_error)
    }

    pub(crate) async fn record_automation_scheduler_error(&self, code: &'static str) {
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let _ = self
            .storage
            .execute(move |db| {
                publish(
                    db,
                    &subscribers,
                    "automation.scheduler_error",
                    &json!({"code":code}),
                    &now,
                )
            })
            .await;
    }
}

pub(super) fn publish(
    db: &rusqlite::Connection,
    subscribers: &events::EventSubscribers,
    kind: &str,
    value: &Value,
    now: &str,
) -> Result<(), AppStorageError> {
    let payload = value.as_object().cloned().unwrap_or_else(Map::new);
    events::append(db, subscribers, kind, None, payload, now)?;
    Ok(())
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
pub(super) fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new("automation_json_failed", error.to_string())
}
fn detail(row: records::AutomationRow) -> AutomationDetail {
    let prompt = row.prompt.clone();
    AutomationDetail {
        summary: records::summary(row),
        prompt_body: prompt,
    }
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn target_summary(value: AutomationSummary) -> Value {
    json!({"automation_id":value.id,"title":value.title,"state":value.state,"interval_label":value.interval_label,"next_run_at":value.next_run_at,"last_run_state":value.last_run_state,"safe_error_code":value.last_safe_error_code})
}
fn required(
    value: &str,
    code: &'static str,
    message: &str,
) -> Result<String, GatewayApplicationError> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        Err(public(400, code, message))
    } else {
        Ok(value)
    }
}
fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
}
fn validate_interval(value: i64) -> Result<(), GatewayApplicationError> {
    if (MIN_INTERVAL..=MAX_INTERVAL).contains(&value) {
        Ok(())
    } else {
        Err(public(
            400,
            "automation_interval_invalid",
            "Automation interval must be between 5 minutes and 24 hours.",
        ))
    }
}
fn validate_interval_row(value: i64) -> Result<(), AppStorageError> {
    if (MIN_INTERVAL..=MAX_INTERVAL).contains(&value) {
        Ok(())
    } else {
        Err(AppStorageError::new(
            "automation_interval_invalid",
            "Automation interval must be between 5 minutes and 24 hours.",
        ))
    }
}
