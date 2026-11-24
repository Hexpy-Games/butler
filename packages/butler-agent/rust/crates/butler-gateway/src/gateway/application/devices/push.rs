use crate::gateway::{
    AppEventEnvelope, AppSettingsFactsProvider, AppSetupPort, ButlerAccountRequest,
    GatewayApplicationError,
    application::{AppApplication, AppStorage, AppStorageError, settings},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::sync::Arc;

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
    pub fn start_push(&self) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Push>();
        let subscription = self.subscribers.subscribe(Arc::new(move |event| {
            if let Some(push) = push_of(event.envelope()) {
                let _ = tx.send(push);
            }
        }));
        let storage = self.storage.clone();
        let settings_facts = self.dependencies.settings_facts.clone();
        let shutdown = self.dependencies.service_shutdown.clone();
        let setup = self.dependencies.setup.clone();
        let sync = self.push_sync.clone();
        tokio::spawn(async move {
            let _subscription = subscription;
            loop {
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    () = sync.notified() => sync_tokens(&storage, setup.as_ref()).await,
                    next = rx.recv() => {
                        let Some(push) = next else { return };
                        tokio::select! {
                            () = shutdown.cancelled() => return,
                            () = deliver(&storage, settings_facts.as_ref(), setup.as_ref(), push) => {}
                        }
                    }
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

fn tokens(db: &Connection) -> Result<Vec<String>, AppStorageError> {
    let mut query = db
        .prepare(
            "SELECT push_token FROM paired_devices
             WHERE revoked_at IS NULL AND push_token IS NOT NULL ORDER BY created_at,id",
        )
        .map_err(AppStorageError::sqlite)?;
    query
        .query_map([], |row| row.get(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

async fn sync_tokens(storage: &AppStorage, setup: &dyn AppSetupPort) {
    match storage.read(tokens).await {
        Ok(tokens) => {
            let _ = setup
                .butler_account(ButlerAccountRequest::PushTokens { tokens })
                .await;
        }
        Err(error) => tracing::debug!(code = error.code(), "push token sync dropped"),
    }
}

async fn deliver(
    storage: &AppStorage,
    settings_facts: &dyn AppSettingsFactsProvider,
    setup: &dyn AppSetupPort,
    push: Push,
) {
    let Ok(facts) = settings_facts.snapshot() else {
        tracing::warn!(code = "internal", "push dropped");
        return;
    };
    let Ok((lang, skip, tokens)) = storage
        .read(move |db| {
            let lang = settings::ui_language(db, &facts)?.as_str();
            let skip = if let Some(id) = push.turn_id {
                db.query_row("SELECT COALESCE(json_type(execution_controls_json,'$.subsession_result')='object'
                                  OR json_type(execution_controls_json,'$.schedule_run')='object'
                                  OR fresh_retry_queue_id IS NOT NULL,0)
                     FROM turns WHERE id=?1",
                    [id], |row| row.get::<_, bool>(0)).map_err(AppStorageError::sqlite)?
            } else {
                false
            };
            Ok((lang, skip, tokens(db)?))
        })
        .await
        .inspect_err(|error| tracing::warn!(code = error.code(), "push dropped"))
    else {
        return;
    };
    if skip || tokens.is_empty() {
        return;
    }
    let kind = match push.status {
        Status::NeedsInput => "needs_input",
        Status::Done => "done",
        Status::Failed => "failed",
        Status::ScheduleBlocked => "schedule_blocked",
    };
    let messages = tokens
        .iter()
        .map(|token| match &push.target {
            Target::Session(id) => json!({"to":token,"kind":kind,"lang":lang,"session_id":id}),
            Target::Automation(id) => {
                json!({"to":token,"kind":kind,"lang":lang,"automation_id":id})
            }
        })
        .collect();
    let Ok(value) = setup
        .butler_account(ButlerAccountRequest::Push { messages, tokens })
        .await
        .inspect_err(|error| {
            let code = match error {
                GatewayApplicationError::Public { code, .. } => code.as_str(),
                GatewayApplicationError::Internal { .. } => "internal",
            };
            match code {
                "butler_account_disabled" | "butler_account_signed_out" => {
                    tracing::debug!(code, "push dropped");
                }
                _ => tracing::warn!(code, "push dropped"),
            }
        })
    else {
        return;
    };
    clear_gone(storage, setup, &value).await;
}

async fn clear_gone(storage: &AppStorage, setup: &dyn AppSetupPort, value: &Value) {
    let gone: Vec<_> = value["gone"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|token| token.as_str().map(str::to_owned))
        .collect();
    if !gone.is_empty() {
        match storage
            .execute(move |db| {
                gone.into_iter().try_fold(0, |cleared, token| {
                    db.execute(
                        "UPDATE paired_devices SET push_token=NULL WHERE push_token=?1",
                        [token],
                    )
                    .map(|rows| cleared + rows)
                    .map_err(AppStorageError::sqlite)
                })
            })
            .await
        {
            Ok(cleared) if cleared > 0 => sync_tokens(storage, setup).await,
            Ok(_) => {}
            Err(error) => tracing::warn!(code = error.code(), "push dropped"),
        }
    }
}
