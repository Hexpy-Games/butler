use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::params;
use serde_json::{Map, Value, json};
use std::sync::Arc;

use super::{
    AutomationDetail, AutomationDetailView, AutomationListView, AutomationMutationResult,
    AutomationRunListView, AutomationSummary, CreateAutomationRequest, UpdateAutomationRequest,
    records,
};
use crate::gateway::AppIdentityClock;
use crate::gateway::application::settings;
use crate::gateway::application::storage::AppStorageCode;
use crate::gateway::application::{
    AppApplication, AppStorageError, GatewayApplicationError, app_error, events, public,
};

const MIN_INTERVAL: i64 = 60;
const MAX_INTERVAL: i64 = 86_400;

impl AppApplication {
    pub(crate) async fn next_automation_due(
        &self,
    ) -> Result<Option<String>, GatewayApplicationError> {
        self.storage
            .read(records::next_due)
            .await
            .map_err(app_error)
    }

    pub(crate) async fn list_automations_owned(
        &self,
        target_session_id: Option<String>,
        include_deleted: bool,
    ) -> Result<AutomationListView, GatewayApplicationError> {
        self.storage
            .read(move |db| {
                Ok(AutomationListView {
                    automations: records::list(db, target_session_id.as_deref(), include_deleted)?
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
            .read(move |db| {
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
            "Schedule title is required.",
        )?;
        let prompt = required(
            &input.prompt_body,
            "automation_prompt_required",
            "Schedule prompt is required.",
        )?;
        let schedule_type = input
            .schedule
            .as_ref()
            .map(|rule| rule.kind.as_str())
            .or(input.schedule_type.as_deref())
            .unwrap_or("interval");
        if input.schedule.is_none() {
            validate_timing(
                schedule_type,
                input.interval_seconds,
                input.run_at.as_deref(),
                input.start_at.as_deref(),
            )?;
        }
        let id = input.id.clone().unwrap_or_else(|| {
            format!("automation-{}", self.dependencies.identity_clock.new_uuid())
        });
        if !safe_id(&id) {
            return Err(public(
                400,
                "automation_id_invalid",
                "Schedule id is invalid.",
            ));
        }
        let now = self.dependencies.identity_clock.now_iso();
        let next = first_run(
            &input,
            schedule_type,
            &now,
            &self.dependencies.identity_clock,
        )
        .await?;
        let schedule_type = schedule_type.to_owned();
        let subscribers = self.subscribers.clone();
        let result = self.storage.execute(move |db| {
            let target = input.target_session_id.trim();
            let (kind, _) = records::target(db, target)?;
            let access = match input.access_mode {
                Some(mode) => mode,
                None => settings::conversation_access_mode(db, target)?,
            };
            db.execute(
                "INSERT INTO app_automations(id,title,prompt_body,target_kind,target_session_id,interval_seconds,schedule_type,run_at,start_at,access_mode,schedule_json,state,next_run_at,last_run_at,last_run_state,last_safe_error_code,run_count,consecutive_failure_count,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?13,'enabled',?11,NULL,'never_run',NULL,0,0,?12,?12)",
                params![id,title,prompt,kind,target,input.interval_seconds,schedule_type,input.run_at,input.start_at,settings::access_mode_name(&access),next,now,input.schedule.as_ref().map(serde_json::to_string).transpose().map_err(json_error)?],
            ).map_err(AppStorageError::sqlite)?;
            // A schedule for another conversation runs on its creator's live site grants.
            if let Some(source) = input.source_session_id.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != target) {
                db.execute("INSERT OR IGNORE INTO app_automation_grant_sources(automation_id,source_session_id) VALUES(?1,?2)", params![id, source]).map_err(AppStorageError::sqlite)?;
            }
            let automation = detail(records::active(db, &id)?);
            publish(db, &subscribers, "automation.created", &json!({"automation":automation.summary}), &now)?;
            Ok(AutomationMutationResult { automation: serde_json::to_value(automation).map_err(json_error)? })
        }).await.map_err(app_error);
        if result.is_ok() {
            self.automation_wake.notify_one();
        }
        result
    }

    pub(crate) async fn update_automation_owned(
        &self,
        id: String,
        input: UpdateAutomationRequest,
    ) -> Result<AutomationMutationResult, GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        let result = self.storage.execute(move |db| {
            let old = records::active(db, &id)?;
            let timing_changed = input.schedule.is_some() || input.interval_seconds.is_some() || input.schedule_type.is_some() || input.run_at.is_some() || input.start_at.is_some();
            let title = nonempty(input.title).unwrap_or(old.title);
            let prompt = nonempty(input.prompt_body).unwrap_or(old.prompt);
            let target_id = nonempty(input.target_session_id).unwrap_or(old.target_id);
            let (kind, _) = records::target(db, &target_id)?;
            let seconds = input.interval_seconds.unwrap_or(old.interval);
            let schedule = input.schedule.or_else(|| if input.schedule_type.is_some() { None } else { old.schedule });
            let schedule_type = schedule.as_ref().map(|rule| rule.kind.clone()).unwrap_or_else(|| input.schedule_type.unwrap_or(old.schedule_type));
            let run_at = input.run_at.or(old.run_at);
            let start_at = input.start_at.or(old.start_at);
            let calendar_next = schedule.as_ref().map(|rule| super::timing::next(rule, &now)).transpose()?;
            if schedule.is_none() { validate_timing_row(&schedule_type, seconds, run_at.as_deref(), start_at.as_deref())?; }
            let access = input.access_mode.unwrap_or(old.access);
            let state = input.state.unwrap_or_else(|| old.state.clone());
            if state != "enabled" && state != "paused" {
                return Err(AppStorageError::new(AppStorageCode::AutomationStateInvalid, "Schedule state must be enabled or paused."));
            }
            let changed = timing_changed || old.state != state;
            let next = if state == "enabled" && changed { Some(calendar_next.unwrap_or_else(|| next_time(&schedule_type, run_at.as_deref(), start_at.as_deref(), seconds, &now, &clock))) } else { old.next };
            db.execute(
                "UPDATE app_automations SET title=?1,prompt_body=?2,target_kind=?3,target_session_id=?4,interval_seconds=?5,state=?6,next_run_at=?7,updated_at=?8,access_mode=?9,schedule_type=?10,run_at=?11,start_at=?12,schedule_json=?14 WHERE id=?13",
                params![title,prompt,kind,target_id,seconds,state,next,now,settings::access_mode_name(&access),schedule_type,run_at,start_at,id,schedule.as_ref().map(serde_json::to_string).transpose().map_err(json_error)?],
            ).map_err(AppStorageError::sqlite)?;
            let automation = detail(records::active(db, &id)?);
            publish(db, &subscribers, "automation.updated", &json!({"automation":automation.summary}), &now)?;
            Ok(AutomationMutationResult { automation: serde_json::to_value(automation).map_err(json_error)? })
        }).await.map_err(app_error);
        if result.is_ok() {
            self.automation_wake.notify_one();
        }
        result
    }

    pub(crate) async fn delete_automation_owned(
        &self,
        id: String,
    ) -> Result<AutomationMutationResult, GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        let result = self.storage.execute(move |db| {
            let mut row = records::get(db, &id)?.ok_or_else(records::not_found)?;
            row.state = "deleted".into(); row.next = None; row.updated = now.clone();
            db.execute("UPDATE app_automations SET state='deleted',next_run_at=NULL,updated_at=?1 WHERE id=?2", params![now,id]).map_err(AppStorageError::sqlite)?;
            let automation = records::summary(row);
            publish(db, &subscribers, "automation.deleted", &json!({"automation":automation}), &now)?;
            Ok(AutomationMutationResult { automation: serde_json::to_value(automation).map_err(json_error)? })
        }).await.map_err(app_error);
        if result.is_ok() {
            self.automation_wake.notify_one();
        }
        result
    }

    pub(crate) async fn list_automation_runs_owned(
        &self,
        id: String,
    ) -> Result<AutomationRunListView, GatewayApplicationError> {
        self.storage
            .read(move |db| {
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
            .read(move |db| read_targets(db, &session_id))
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
pub(super) fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new(AppStorageCode::AutomationJsonFailed, error.to_string()).with_source(error)
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
    json!({"automation_id":value.id,"title":value.title,"state":value.state,"interval_seconds":value.interval_seconds,"schedule_type":value.schedule_type,"schedule":value.schedule,"access_mode":value.access_mode,"next_run_at":value.next_run_at,"last_run_state":value.last_run_state,"safe_error_code":value.last_safe_error_code})
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
fn validate_timing(
    kind: &str,
    seconds: i64,
    run_at: Option<&str>,
    start_at: Option<&str>,
) -> Result<(), GatewayApplicationError> {
    if valid_timing(kind, seconds, run_at, start_at) {
        Ok(())
    } else {
        Err(public(
            400,
            "automation_interval_invalid",
            "Schedule timing is invalid.",
        ))
    }
}
fn validate_timing_row(
    kind: &str,
    seconds: i64,
    run_at: Option<&str>,
    start_at: Option<&str>,
) -> Result<(), AppStorageError> {
    if valid_timing(kind, seconds, run_at, start_at) {
        Ok(())
    } else {
        Err(AppStorageError::new(
            AppStorageCode::AutomationIntervalInvalid,
            "Schedule timing is invalid.",
        ))
    }
}

fn valid_timing(kind: &str, seconds: i64, run_at: Option<&str>, start_at: Option<&str>) -> bool {
    match kind {
        "once" => run_at.is_some_and(|value| DateTime::parse_from_rfc3339(value).is_ok()),
        "interval" => {
            (MIN_INTERVAL..=MAX_INTERVAL).contains(&seconds)
                && start_at.is_none_or(|value| DateTime::parse_from_rfc3339(value).is_ok())
        }
        _ => false,
    }
}

fn next_time(
    kind: &str,
    run_at: Option<&str>,
    start_at: Option<&str>,
    seconds: i64,
    now: &str,
    clock: &Arc<dyn AppIdentityClock>,
) -> String {
    if kind == "once" {
        return canonical_time(run_at.unwrap_or(now));
    }
    start_at.map(canonical_time).unwrap_or_else(|| {
        clock.iso_after_millis(u64::try_from(seconds).unwrap_or_default() * 1000)
    })
}

fn canonical_time(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|time| {
            time.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .unwrap_or_else(|_| value.to_owned())
}

fn safe_id(id: &str) -> bool {
    (1..=100).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

async fn first_run(
    input: &CreateAutomationRequest,
    schedule_type: &str,
    now: &str,
    clock: &Arc<dyn AppIdentityClock>,
) -> Result<String, GatewayApplicationError> {
    let next = if let Some(rule) = input.schedule.clone() {
        let at = now.to_owned();
        tokio::task::spawn_blocking(move || super::timing::next(&rule, &at))
            .await
            .map_err(GatewayApplicationError::internal_from)?
            .map_err(|_| {
                public(
                    400,
                    "automation_interval_invalid",
                    "Schedule timing is invalid.",
                )
            })?
    } else {
        next_time(
            schedule_type,
            input.run_at.as_deref(),
            input.start_at.as_deref(),
            input.interval_seconds,
            now,
            clock,
        )
    };
    Ok(next)
}

pub(in crate::gateway::application) fn read_targets(
    db: &rusqlite::Connection,
    session: &str,
) -> Result<Value, AppStorageError> {
    let targets = records::list(db, Some(session), false)?
        .into_iter()
        .map(records::summary)
        .map(target_summary)
        .collect::<Vec<_>>();
    serde_json::to_value(targets).map_err(json_error)
}
