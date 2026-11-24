mod expo;

use crate::gateway::AppSettingsFactsProvider;
use crate::gateway::{
    AppEventEnvelope,
    application::{AppApplication, AppStorage, AppStorageError, settings},
    ui_language::UiLanguage,
};
use butler_log::http::{self, Client};
use rusqlite::params;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[derive(Clone, Copy)]
enum Status {
    NeedsInput,
    Done,
    Failed,
    ScheduleBlocked,
}

enum Target {
    Session(String),
    Automation(String),
}

struct Push {
    status: Status,
    target: Target,
    turn_id: Option<String>,
}

impl AppApplication {
    /// Sends status notifications for newly published app events.
    pub fn start_push(&self, url: String) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Push>();
        let subscription = self.subscribers.subscribe(Arc::new(move |event| {
            if let Some(push) = push_of(event.envelope()) {
                let _ = tx.send(push);
            }
        }));
        let Ok(client) = http::external(http::Purpose::new("push"))
            .timeout(Duration::from_secs(10))
            .build()
        else {
            tracing::warn!(code = "push_client_build_failed");
            return;
        };
        let storage = self.storage.clone();
        let settings_facts = self.dependencies.settings_facts.clone();
        let shutdown = self.dependencies.service_shutdown.clone();
        tokio::spawn(async move {
            let _subscription = subscription;
            loop {
                let next = tokio::select! {
                    () = shutdown.cancelled() => return,
                    next = rx.recv() => next,
                };
                let Some(push) = next else { return };
                let result = tokio::select! {
                    () = shutdown.cancelled() => return,
                    result = deliver(&storage, settings_facts.as_ref(), &client, &url, push) => result,
                };
                if let Err(code) = result {
                    tracing::warn!(code, "push delivery failed");
                }
            }
        });
    }
}

fn push_of(event: &AppEventEnvelope) -> Option<Push> {
    let payload = &event.payload;
    let (status, target, turn_id) = match event.event_type.as_str() {
        "pending_asks.changed" if payload.get("state")?.as_str()? == "open" => (
            Status::NeedsInput,
            Target::Session(payload.get("session_id")?.as_str()?.into()),
            None,
        ),
        "turn.state_changed" => {
            let (turn, chat_key, id_key) = match payload.get("turn").and_then(Value::as_object) {
                Some(turn) => (turn, "chat_id", "id"),
                None => (payload, "session_id", "turn_id"),
            };
            let status = match turn.get("state")?.as_str()? {
                "delivered" => Status::Done,
                "failed" | "runtime_fault" => Status::Failed,
                _ => return None,
            };
            (
                status,
                Target::Session(turn.get(chat_key)?.as_str()?.into()),
                Some(turn.get(id_key)?.as_str()?.into()),
            )
        }
        "automation.run"
            if payload.get("attention")?.as_bool()?
                && matches!(
                    payload.get("safe_error_code")?.as_str()?,
                    "schedule_permission_required" | "schedule_signin_off" | "schedule_payment_off"
                ) =>
        {
            (
                Status::ScheduleBlocked,
                Target::Automation(payload.get("automation_id")?.as_str()?.into()),
                None,
            )
        }
        _ => return None,
    };
    Some(Push {
        status,
        target,
        turn_id,
    })
}

async fn deliver(
    storage: &AppStorage,
    settings_facts: &dyn AppSettingsFactsProvider,
    client: &Client,
    url: &str,
    push: Push,
) -> Result<(), &'static str> {
    let facts = settings_facts.snapshot().map_err(|_| "internal")?;
    let (language, skip, targets) = storage
        .read(move |db| {
            let language = settings::ui_language(db, &facts)?;
            let skip = if let Some(id) = push.turn_id {
                db.query_row(
                    "SELECT COALESCE(json_type(execution_controls_json,'$.subsession_result')='object'
                                  OR json_type(execution_controls_json,'$.schedule_run')='object'
                                  OR fresh_retry_queue_id IS NOT NULL,0)
                     FROM turns WHERE id=?1",
                    [id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(AppStorageError::sqlite)?
            } else {
                false
            };
            let mut query = db.prepare(
                "SELECT id,push_token FROM paired_devices
                 WHERE revoked_at IS NULL AND push_token IS NOT NULL ORDER BY created_at,id",
            ).map_err(AppStorageError::sqlite)?;
            let targets = query
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(AppStorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(AppStorageError::sqlite)?;
            Ok((language, skip, targets))
        })
        .await
        .map_err(|error| error.code())?;
    if skip || targets.is_empty() {
        return Ok(());
    }
    let (title, body) = copy(push.status, language);
    let kind = match push.status {
        Status::NeedsInput => "needs_input",
        Status::Done => "done",
        Status::Failed => "failed",
        Status::ScheduleBlocked => "schedule_blocked",
    };
    let data = match push.target {
        Target::Session(id) => json!({"kind":kind,"session_id":id}),
        Target::Automation(id) => json!({"kind":kind,"automation_id":id}),
    };
    let messages: Vec<_> = targets.iter().map(|(_, token)| {
        json!({"to":token,"title":title,"body":body,"sound":"default","data":data})
    }).collect();
    let unregistered = expo::send(client, url, &messages)
        .await
        .map_err(|error| error.code)?;
    for index in unregistered {
        let (id, token) = targets[index].clone();
        storage
            .execute(move |db| {
                db.execute(
                    "UPDATE paired_devices SET push_token=NULL WHERE id=?1 AND push_token=?2",
                    params![id, token],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .map_err(|error| error.code())?;
    }
    Ok(())
}

fn copy(status: Status, language: UiLanguage) -> (&'static str, &'static str) {
    match (status, language) {
        (Status::NeedsInput, UiLanguage::English) => ("Butler", "Needs your input"),
        (Status::Done, UiLanguage::English) => ("Butler", "Done"),
        (Status::Failed, UiLanguage::English) => ("Butler", "Failed"),
        (Status::ScheduleBlocked, UiLanguage::English) => ("Butler", "Schedule stopped"),
        (Status::NeedsInput, UiLanguage::Korean) => ("버틀러", "확인 필요"),
        (Status::Done, UiLanguage::Korean) => ("버틀러", "완료"),
        (Status::Failed, UiLanguage::Korean) => ("버틀러", "실패"),
        (Status::ScheduleBlocked, UiLanguage::Korean) => ("버틀러", "예약 작업 멈춤"),
    }
}
