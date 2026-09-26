use rusqlite::{OptionalExtension, params};
use serde_json::json;

use super::{
    AutomationRunListView, AutomationRunResult, AutomationRunSummary,
    records::{self, AutomationRow, QueuedRunRow},
    store::publish,
};
use crate::gateway::{
    MessageRecord, MessageRole, MessageSendRequest, MessageStatus,
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
    pub(crate) async fn run_automation_owned(
        &self,
        id: String,
        trigger: &'static str,
    ) -> Result<AutomationRunResult, GatewayApplicationError> {
        self.automation_runs.execute(id, trigger).await
    }

    pub(crate) async fn dispatch_due_owned(
        &self,
    ) -> Result<AutomationRunListView, GatewayApplicationError> {
        self.automation_runs.due().await
    }

    pub(crate) async fn execute_automation(
        &self,
        id: String,
        trigger: &'static str,
    ) -> Result<AutomationRunResult, GatewayApplicationError> {
        let started = self.dependencies.identity_clock.now_iso();
        let run_id = format!(
            "automation-run-{}",
            self.dependencies.identity_clock.new_uuid()
        );
        let placeholder_id = format!("message-{}", self.dependencies.identity_clock.new_uuid());
        let stored_placeholder_id = placeholder_id.clone();
        let run = run_id.clone();
        let automation_id = id.clone();
        let (row, queued) = self.storage.execute(move |db| {
            let row = records::active(db, &automation_id)?;
            if trigger == "scheduled" && row.state != "enabled" {
                return Err(AppStorageError::new("automation_not_enabled", "Automation is not enabled."));
            }
            let busy = session_has_active_turn(db, &row.target_id)?;
            db.execute(
                "INSERT INTO app_automation_runs(id,automation_id,target_session_id,state,trigger,started_at) VALUES(?1,?2,?3,'running',?4,?5)",
                params![run,row.id,row.target_id,trigger,started],
            ).map_err(AppStorageError::sqlite)?;
            if busy {
                db.execute(
                    "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,retryable) VALUES(?1,?2,'automation','Automation prompt queued.','pending',?3,?3,0)",
                    params![stored_placeholder_id,row.target_id,started],
                ).map_err(AppStorageError::sqlite)?;
            }
            Ok((row, busy))
        }).await.map_err(app_error)?;
        if queued {
            return self
                .complete_fresh_run(
                    row,
                    run_id,
                    trigger,
                    DispatchResult {
                        state: "queued",
                        safe_error: None,
                        turn_id: Some(placeholder_id),
                    },
                )
                .await;
        }
        let result = self.send_automation(&row, &run_id).await;
        self.complete_fresh_run(row, run_id, trigger, result).await
    }

    pub(crate) async fn execute_due_automations(
        &self,
    ) -> Result<AutomationRunListView, GatewayApplicationError> {
        let queued = self
            .storage
            .execute(|db| records::queued(db))
            .await
            .map_err(app_error)?;
        let mut runs = Vec::new();
        for row in queued {
            if self
                .target_has_active_turn(row.run_target_id.clone())
                .await?
            {
                continue;
            }
            runs.push(self.dispatch_queued(row).await?);
        }
        let now = self.dependencies.identity_clock.now_iso();
        let due = self
            .storage
            .execute(move |db| records::due(db, &now))
            .await
            .map_err(app_error)?;
        for row in due {
            runs.push(self.execute_automation(row.id, "scheduled").await?.run);
        }
        Ok(AutomationRunListView { runs })
    }

    async fn target_has_active_turn(
        &self,
        target_id: String,
    ) -> Result<bool, GatewayApplicationError> {
        self.storage
            .execute(move |db| session_has_active_turn(db, &target_id))
            .await
            .map_err(app_error)
    }

    async fn dispatch_queued(
        &self,
        queued: QueuedRunRow,
    ) -> Result<AutomationRunSummary, GatewayApplicationError> {
        let mut dispatch = queued.automation.clone();
        dispatch.target_id = queued.run_target_id.clone();
        let mut result = self.send_automation(&dispatch, &queued.run_id).await;
        if result.state == "failed" && result.safe_error.as_deref() == Some("session_not_found") {
            result.state = "skipped_target_unavailable";
        }
        let completed = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move|db|{
            record_run(db,&queued.run_id,&result,&completed,queued.placeholder_id.as_deref())?;
            if let Some(message_id) = queued.placeholder_id.as_deref() {
                let message = placeholder_message(db, message_id)?;
                publish(
                    db,
                    &subscribers,
                    "message.updated",
                    json!({"message": message}),
                    &completed,
                )?;
            }
            db.execute("UPDATE app_automations SET last_run_at=?1,last_run_state=?2,last_safe_error_code=?3,consecutive_failure_count=CASE WHEN ?2='failed' THEN consecutive_failure_count+1 ELSE 0 END,updated_at=?1 WHERE id=?4",params![completed,result.state,result.safe_error,queued.automation.id]).map_err(AppStorageError::sqlite)?;
            let run=records::run(db,&queued.run_id)?;
            publish(
                db,
                &subscribers,
                "automation.run",
                run_event(
                    queued.automation.id,
                    queued.run_target_id,
                    run.state.clone(),
                    queued.trigger,
                    run.safe_error_code.clone(),
                ),
                &completed,
            )?;
            Ok(run)
        }).await.map_err(app_error)
    }

    async fn send_automation(&self, row: &AutomationRow, run_id: &str) -> DispatchResult {
        let request = MessageSendRequest {
            expected_project_id: None,
            content_parts: None,
            chat_id: Some(json!(row.target_id)),
            text: Some(json!(row.prompt)),
            client_message_id: Some(json!(format!("automation-{}-{run_id}", row.id))),
            attachments: None,
            model: None,
            reasoning_effort: None,
            access_mode: None,
            plan_mode: None,
            subsession_result: None,
        };
        match self
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
        }
    }

    async fn complete_fresh_run(
        &self,
        row: AutomationRow,
        run_id: String,
        trigger: &str,
        result: DispatchResult,
    ) -> Result<AutomationRunResult, GatewayApplicationError> {
        let completed = self.dependencies.identity_clock.now_iso();
        let next = if row.state == "enabled" {
            Some(
                self.dependencies
                    .identity_clock
                    .iso_after_millis(row.interval as u64 * 1000),
            )
        } else {
            row.next.clone()
        };
        let subscribers = self.subscribers.clone();
        let trigger = trigger.to_owned();
        self.storage.execute(move|db|{
            let placeholder=if result.state=="queued"{result.turn_id.as_deref()}else{None};
            record_run(db,&run_id,&result,&completed,placeholder)?;
            db.execute("UPDATE app_automations SET next_run_at=?1,last_run_at=?2,last_run_state=?3,last_safe_error_code=?4,run_count=run_count+1,consecutive_failure_count=CASE WHEN ?3='failed' THEN consecutive_failure_count+1 ELSE 0 END,updated_at=?2 WHERE id=?5",params![next,completed,result.state,result.safe_error,row.id]).map_err(AppStorageError::sqlite)?;
            let run=records::run(db,&run_id)?;
            publish(
                db,
                &subscribers,
                "automation.run",
                run_event(
                    row.id.clone(),
                    row.target_id.clone(),
                    run.state.clone(),
                    trigger,
                    run.safe_error_code.clone(),
                ),
                &completed,
            )?;
            Ok(AutomationRunResult{automation:records::summary(records::active(db,&row.id)?),run})
        }).await.map_err(app_error)
    }
}

fn session_has_active_turn(
    db: &rusqlite::Connection,
    target_id: &str,
) -> Result<bool, AppStorageError> {
    let latest = db
        .query_row(
            "SELECT state,safe_error_code FROM turns WHERE chat_id=?1 ORDER BY rowid DESC LIMIT 1",
            [target_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(latest.is_some_and(|(state, error)| {
        error.as_deref() != Some("provider_round_timeout")
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
    }))
}

fn run_event(
    automation_id: String,
    target_session_id: String,
    state: String,
    trigger: String,
    safe_error_code: Option<String>,
) -> serde_json::Value {
    let mut event = json!({
        "automation_id": automation_id,
        "target_session_id": target_session_id,
        "state": state,
        "trigger": trigger,
    });
    if let Some(code) = safe_error_code {
        event["safe_error_code"] = json!(code);
    }
    event
}

fn placeholder_message(
    db: &rusqlite::Connection,
    message_id: &str,
) -> Result<MessageRecord, AppStorageError> {
    db.query_row(
        "SELECT rowid,id,chat_id,text,status,created_at,updated_at,safe_error_code,retryable FROM messages WHERE id=?1",
        [message_id],
        |row| {
            let status: String = row.get(4)?;
            let status = match status.as_str() {
                "delivered" => MessageStatus::Delivered,
                "failed" => MessageStatus::Failed,
                _ => MessageStatus::Pending,
            };
            Ok(MessageRecord {
                content_parts: None,
                id: row.get(1)?,
                chat_id: row.get(2)?,
                turn_id: None,
                conversation_session_id: None,
                conversation_turn_id: None,
                conversation_message_id: None,
                role: MessageRole::Automation,
                text: row.get(3)?,
                status,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                safe_error_code: row.get(7)?,
                delivery_state: None,
                limitation_codes: None,
                limitations: None,
                retryable: row.get::<_, i64>(8)? == 1,
                cursor: row.get(0)?,
                attachments: None,
                artifacts: None,
                changed_files: None,
                plan_document: None,
                work_blocks: None,
                turn_activity_rows: None,
            })
        },
    )
    .map_err(AppStorageError::sqlite)
}

fn record_run(
    db: &rusqlite::Connection,
    run_id: &str,
    result: &DispatchResult,
    completed: &str,
    placeholder: Option<&str>,
) -> Result<(), AppStorageError> {
    let turn = if result.state == "queued" {
        None
    } else {
        result.turn_id.as_deref()
    };
    db.execute("UPDATE app_automation_runs SET state=?1,completed_at=?2,safe_error_code=?3,queued_message_id=?4,turn_id=?5 WHERE id=?6",params![result.state,completed,result.safe_error,placeholder,turn,run_id]).map_err(AppStorageError::sqlite)?;
    if let Some(message_id) = placeholder {
        let (text, status, retryable) = if result.state == "queued" {
            ("Automation prompt queued.", "pending", 0)
        } else if result.state == "succeeded" {
            ("Automation prompt dispatched.", "delivered", 0)
        } else {
            ("Automation prompt could not be dispatched.", "failed", 1)
        };
        db.execute("UPDATE messages SET text=?1,status=?2,safe_error_code=?3,retryable=?4,updated_at=?5 WHERE id=?6",params![text,status,result.safe_error,retryable,completed,message_id]).map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}
