use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::{
    AutomationRunListView, AutomationRunResult, AutomationRunSummary,
    records::{self, AutomationRow, QueuedRunRow},
    store::publish,
};
use crate::gateway::application::queue_dispatcher::session_has_active_turn;
use crate::gateway::application::storage::AppStorageCode;
use crate::gateway::application::{initiated::Hold, settings};
use crate::gateway::{
    MessageSendRequest,
    application::{
        AppApplication, AppStorageError, GatewayApplicationError, SendMessageCommand, app_error,
    },
};

struct DispatchResult {
    state: &'static str,
    safe_error: Option<String>,
    turn_id: Option<String>,
}

impl AppApplication {
    pub(crate) async fn dispatch_due_request(
        &self,
    ) -> Result<AutomationRunListView, GatewayApplicationError> {
        #[cfg(feature = "e2e-fixtures")]
        self.inject_dispatch_fault().await?;
        self.dispatch_due_owned().await
    }

    pub(crate) async fn run_automation_owned(
        &self,
        id: String,
        trigger: &'static str,
    ) -> Result<AutomationRunResult, GatewayApplicationError> {
        let result = self.automation_runs.execute(id, trigger).await;
        if result.is_ok() {
            self.automation_wake.notify_one();
        }
        result
    }

    pub(crate) async fn dispatch_due_owned(
        &self,
    ) -> Result<AutomationRunListView, GatewayApplicationError> {
        let runs = self.automation_runs.due().await?;
        self.deliver_initiated().await?;
        Ok(runs)
    }

    pub(crate) async fn execute_automation(
        &self,
        id: String,
        trigger: &'static str,
    ) -> Result<AutomationRunResult, GatewayApplicationError> {
        let hold = self
            .automation_hold(
                self.get_automation_owned(id.clone())
                    .await?
                    .automation
                    .summary
                    .target_session_id,
                trigger,
                self.dependencies.identity_clock.now_iso(),
            )
            .await?;
        let held = !matches!(hold, Hold::Free);
        let paused = if held {
            false
        } else {
            self.pause_unopened_report(id.clone(), trigger).await?
        };
        let (row, queued, run_id) = self
            .prepare_automation_run(id, trigger, hold, paused)
            .await?;
        if paused || queued {
            if queued && !paused {
                self.automation_queued
                    .store(true, std::sync::atomic::Ordering::Release);
                self.automation_wake.notify_one();
            }
            return self
                .complete_fresh_run(
                    row,
                    run_id,
                    trigger,
                    DispatchResult {
                        state: if paused {
                            "skipped_report_unopened"
                        } else {
                            "queued"
                        },
                        safe_error: None,
                        turn_id: None,
                    },
                )
                .await;
        }
        let result = self.send_automation(&row, &run_id, trigger).await;
        self.complete_fresh_run(row, run_id, trigger, result).await
    }

    async fn prepare_automation_run(
        &self,
        id: String,
        trigger: &'static str,
        hold: Hold,
        paused: bool,
    ) -> Result<(AutomationRow, bool, String), GatewayApplicationError> {
        let held = !matches!(hold, Hold::Free);
        let started = self.dependencies.identity_clock.now_iso();
        let run = format!(
            "automation-run-{}",
            self.dependencies.identity_clock.new_uuid()
        );
        let message_id = super::super::admission_identity::stable_client_id(
            Some(&json!(format!("automation-{id}-{run}"))),
            &*self.dependencies.identity_clock,
        )?;
        self.storage.execute(move |db| {
            let row = records::active(db, &id)?;
            if trigger == "scheduled" && row.state != "enabled" && !paused {
                return Err(AppStorageError::new(AppStorageCode::AutomationNotEnabled, "Schedule is not enabled."));
            }
            let scheduled_at = if trigger == "scheduled" { super::occurrence::latest(&row, &started)? } else { None };
            let late = super::occurrence::is_late(scheduled_at.as_deref(), &started);
            if trigger == "scheduled" {
                let existing: Option<String> = db.query_row(
                    "SELECT id FROM app_automation_runs WHERE automation_id=?1 AND target_session_id=?2 AND state='queued' AND trigger='scheduled' LIMIT 1",
                    params![row.id, row.target_id], |r| r.get(0),
                ).optional().map_err(AppStorageError::sqlite)?;
                if let Some(run) = existing {
                    db.execute(
                        "UPDATE app_automation_runs SET scheduled_at=?1,late=?2 WHERE id=?3",
                        params![scheduled_at, late, run],
                    ).map_err(AppStorageError::sqlite)?;
                    // Keep this target's queued input and destination after an edit.
                    return Ok((row, true, run));
                }
            }
            let busy = held || session_has_active_turn(db, &row.target_id)?;
            db.execute(
                "INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at,scheduled_at,late) VALUES(?1,?2,?3,'running',?4,?5,?6,?7)",
                params![run,row.id,row.target_id,trigger,started,scheduled_at,late],
            ).map_err(AppStorageError::sqlite)?;
            super::holds::record(db, &run, hold, &started)?;
            // Bind the schedule input before dispatch can run any browser tools.
            db.execute(
                "INSERT INTO app_automation_run_inputs(message_id,run_id) VALUES(?1,?2)",
                params![message_id, run],
            ).map_err(AppStorageError::sqlite)?;
            Ok((row, busy, run))
        }).await.map_err(app_error)
    }

    pub(crate) async fn execute_due_automations(
        &self,
    ) -> Result<AutomationRunListView, GatewayApplicationError> {
        let mut runs = Vec::new();
        // One cutoff for due occurrences and release gates: crossing a hold's
        // end between passes must not release a run before its occurrence merges.
        let now = self.dependencies.identity_clock.now_iso();
        let due_at = now.clone();
        let due = self
            .storage
            .read(move |db| records::due(db, &due_at))
            .await
            .map_err(app_error)?;
        for row in due {
            runs.push(self.execute_automation(row.id, "scheduled").await?.run);
        }
        let queued = self
            .storage
            .read(records::queued)
            .await
            .map_err(app_error)?;
        self.automation_queued
            .store(!queued.is_empty(), std::sync::atomic::Ordering::Release);
        let mut still_queued = false;
        let batch_full = queued.len() == 20;
        let mut dispatched_queued = 0;
        for row in queued {
            let hold = self
                .automation_hold(row.run_target_id.clone(), &row.trigger, now.clone())
                .await?;
            let held = !matches!(hold, Hold::Free);
            let run = row.run_id.clone();
            let held_at = now.clone();
            self.storage
                .execute(move |db| super::holds::record(db, &run, hold, &held_at))
                .await
                .map_err(app_error)?;
            if held {
                still_queued = true;
                continue;
            }
            runs.push(self.dispatch_queued(row).await?);
            dispatched_queued += 1;
        }
        self.automation_queued.store(
            still_queued || batch_full,
            std::sync::atomic::Ordering::Release,
        );
        if batch_full && dispatched_queued > 0 {
            self.automation_wake.notify_one();
        }
        Ok(AutomationRunListView { runs })
    }

    async fn dispatch_queued(
        &self,
        queued: QueuedRunRow,
    ) -> Result<AutomationRunSummary, GatewayApplicationError> {
        if self
            .pause_unopened_report(queued.automation.id.clone(), &queued.trigger)
            .await?
        {
            return self.skip_unopened_queued(queued.run_id).await;
        }
        let mut dispatch = queued.automation.clone();
        dispatch.target_id = queued.run_target_id.clone();
        let mut result = self
            .send_automation(&dispatch, &queued.run_id, &queued.trigger)
            .await;
        if result.state == "failed" && result.safe_error.as_deref() == Some("session_not_found") {
            result.state = "skipped_target_unavailable";
        }
        let completed = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move|db|{
            record_run(db,&queued.run_id,&result,&completed)?;
            if let Some(message_id) = queued.placeholder_id.as_deref() {
                remove_placeholder(db, &subscribers, message_id, &completed)?;
            }
            db.execute("UPDATE app_automations SET last_run_at=?1,last_run_state=?2,last_safe_error_code=COALESCE(?3,(SELECT safe_error_code FROM app_automation_runs WHERE id=?5)),consecutive_failure_count=CASE WHEN ?2='failed' THEN consecutive_failure_count+1 ELSE 0 END,updated_at=?1 WHERE id=?4",params![completed,result.state,result.safe_error,queued.automation.id,queued.run_id]).map_err(AppStorageError::sqlite)?;
            let run=records::run(db,&queued.run_id)?;
            publish(
                db,
                &subscribers,
                "automation.run",
                &run_event(&run),
                &completed,
            )?;
            Ok(run)
        }).await.map_err(app_error)
    }

    #[tracing::instrument(name = "schedule.run", parent = None, skip_all, fields(run_id, chat_id = %row.target_id, status = tracing::field::Empty))]
    async fn send_automation(
        &self,
        row: &AutomationRow,
        run_id: &str,
        trigger: &str,
    ) -> DispatchResult {
        let Ok(context) = self.schedule_context(&row.id, run_id, trigger).await else {
            return DispatchResult {
                state: "failed",
                safe_error: Some("automation_dispatch_failed".into()),
                turn_id: None,
            };
        };
        let model = self.automation_model_override(row.model.as_deref());
        let request = MessageSendRequest {
            image_edit: None,
            expected_project_id: None,
            content_parts: None,
            chat_id: Some(json!(row.target_id)),
            text: Some(json!(row.prompt)),
            client_message_id: Some(json!(format!("automation-{}-{run_id}", row.id))),
            attachments: None,
            model,
            reasoning_effort: None,
            // The schedule's own access, whatever the conversation's mode (#237).
            access_mode: Some(json!(settings::access_mode_name(&row.access))),
            plan_mode: None,
            subsession_result: None,
            // A scheduler-started run has nobody to answer an approval (D8);
            // "run now" is attended and asks as usual.
            schedule_run: Some(context),
        };
        let result = match self
            .send(SendMessageCommand {
                request,
                chat_id: row.target_id.clone(),
            })
            .await
        {
            Ok(sent) => match sent.turn {
                Some(turn) => DispatchResult {
                    state: "succeeded",
                    safe_error: None,
                    turn_id: Some(turn.id),
                },
                None => DispatchResult {
                    state: "failed",
                    safe_error: Some("automation_dispatch_failed".into()),
                    turn_id: None,
                },
            },
            Err(GatewayApplicationError::Public { code, .. }) => DispatchResult {
                state: "failed",
                safe_error: Some(code),
                turn_id: None,
            },
            Err(_) => DispatchResult {
                state: "failed",
                safe_error: Some("automation_dispatch_failed".into()),
                turn_id: None,
            },
        };
        if result.state == "failed" {
            tracing::error!(category = "schedule", event = "schedule.failed", reason = ?result.safe_error, "Schedule run failed");
        }
        result
    }

    /// The schedule's stored model, read from the current settings snapshot only.
    /// Without a snapshot or a selectable model the run follows the chat's model.
    fn automation_model_override(&self, model: Option<&str>) -> Option<Value> {
        let facts = self.dependencies.settings_facts.snapshot().ok()?;
        settings::selectable_model_ref(&facts, model?).map(Value::String)
    }

    async fn complete_fresh_run(
        &self,
        row: AutomationRow,
        run_id: String,
        trigger: &str,
        result: DispatchResult,
    ) -> Result<AutomationRunResult, GatewayApplicationError> {
        let completed = self.dependencies.identity_clock.now_iso();
        let next = if row.schedule_type == "once" {
            None
        } else if row.state == "enabled" && row.schedule.is_some() {
            let rule = row.schedule.clone();
            let now = completed.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    super::timing::next(rule.as_ref().ok_or_else(super::timing::invalid)?, &now)
                })
                .await
                .map_err(GatewayApplicationError::internal_from)?
                .map_err(app_error)?,
            )
        } else if row.state == "enabled" {
            Some(
                super::timing::interval_next(
                    row.start_at
                        .as_deref()
                        .or(row.next.as_deref())
                        .ok_or_else(super::timing::invalid)
                        .map_err(app_error)?,
                    row.interval,
                    &completed,
                    if trigger == "scheduled" {
                        row.next.as_deref()
                    } else {
                        None
                    },
                )
                .map_err(app_error)?,
            )
        } else {
            row.next.clone()
        };
        let subscribers = self.subscribers.clone();
        self.storage.execute(move|db|{
            record_run(db,&run_id,&result,&completed)?;
            db.execute("UPDATE app_automations SET next_run_at=?1,last_run_at=?2,last_run_state=?3,last_safe_error_code=COALESCE(?4,(SELECT safe_error_code FROM app_automation_runs WHERE id=?6)),run_count=run_count+1,consecutive_failure_count=CASE WHEN ?3='failed' THEN consecutive_failure_count+1 ELSE 0 END,updated_at=?2,state=CASE WHEN schedule_type='once' THEN 'paused' ELSE state END WHERE id=?5",params![next,completed,result.state,result.safe_error,row.id,run_id]).map_err(AppStorageError::sqlite)?;
            let run=records::run(db,&run_id)?;
            publish(
                db,
                &subscribers,
                "automation.run",
                &run_event(&run),
                &completed,
            )?;
            Ok(AutomationRunResult{automation:records::summary(records::active(db,&row.id)?),run})
        }).await.map_err(app_error)
    }
}

pub(super) fn run_event(run: &AutomationRunSummary) -> serde_json::Value {
    let mut event = json!({
        "automation_id": run.automation_id, "target_session_id": run.target_session_id,
        "state": run.state, "trigger": run.trigger,
        "scheduled_at": run.scheduled_at, "late": run.late,
    });
    if let Some(code) = &run.safe_error_code {
        event["safe_error_code"] = json!(code);
    }
    event
}

/// Removes the chat message an earlier version wrote for a queued run; the
/// schedule's run list shows a queued run.
fn remove_placeholder(
    db: &rusqlite::Connection,
    subscribers: &crate::gateway::application::events::EventSubscribers,
    message_id: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let chat: Option<String> = db
        .query_row(
            "SELECT chat_id FROM app_owned_messages WHERE id=?1 AND role='automation'",
            [message_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some(chat) = chat else { return Ok(()) };
    db.execute("DELETE FROM messages WHERE id=?1", [message_id])
        .map_err(AppStorageError::sqlite)?;
    publish(
        db,
        subscribers,
        "message.deleted",
        &json!({"message_id":message_id,"chat_id":chat,"role":"automation"}),
        now,
    )
}

fn record_run(
    db: &rusqlite::Connection,
    run_id: &str,
    result: &DispatchResult,
    completed: &str,
) -> Result<(), AppStorageError> {
    let turn = if result.state == "queued" {
        None
    } else {
        result.turn_id.as_deref()
    };
    // An unattended run may report attention (D8) before its dispatch is
    // recorded; the schedule's last code then follows the run's.
    db.execute("UPDATE app_automation_runs SET state=?1,completed_at=?2,safe_error_code=COALESCE(?3,safe_error_code),turn_id=?4 WHERE id=?5",params![result.state,completed,result.safe_error,turn,run_id]).map_err(AppStorageError::sqlite)?;
    Ok(())
}
