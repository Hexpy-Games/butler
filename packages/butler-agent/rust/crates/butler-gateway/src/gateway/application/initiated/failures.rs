//! One durable failure notice per result, shared by terminal and capped retries.
use super::{super::*, outbox};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub(super) enum Reason {
    HookBlocked,
    ModelUnavailable,
    InvalidRequest,
    Unknown,
}
impl Reason {
    pub(super) fn from_code(code: &str) -> Self {
        match code {
            "hook_blocked" => Self::HookBlocked,
            "session_model_unavailable" => Self::ModelUnavailable,
            "invalid_message_content" | "empty_queued_message" | "too_many_attachments" => {
                Self::InvalidRequest
            }
            _ => Self::Unknown,
        }
    }
    pub(super) fn from_error(error: &GatewayApplicationError) -> Self {
        match error {
            GatewayApplicationError::Public { code, .. } => Self::from_code(code),
            GatewayApplicationError::Internal { .. } => Self::Unknown,
        }
    }
    fn code(&self) -> &'static str {
        match self {
            Self::HookBlocked => "hook_blocked",
            Self::ModelUnavailable => "session_model_unavailable",
            Self::InvalidRequest => "invalid_request",
            Self::Unknown => "unknown_error",
        }
    }
}

pub(super) fn enqueue(
    db: &Connection,
    id: &str,
    reason: &Reason,
    language: &str,
    retrying: bool,
    now: &str,
) -> Result<Option<crate::gateway::AppEventEnvelope>, AppStorageError> {
    let (chat, source, title, raw): (String, String, String, String) = db.query_row(
        "SELECT chat_id,source_key,text,payload_json FROM app_initiated_messages WHERE id=?1 AND kind='work_result'",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(AppStorageError::sqlite)?;
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let text = match (language.starts_with("ko"), retrying) {
        (true, false) => "작업 결과를 전달하지 못했어요",
        (true, true) => "작업 결과를 아직 전달하지 못했어요",
        (false, false) => "Couldn't deliver the work result",
        (false, true) => "The work result hasn't been delivered yet",
    };
    let source = format!("work-failed:{source}");
    let key = format!(
        "work-failed-{}",
        butler_turn::btcc::digest_identity(&source)
    );
    let payload = json!({"work_session_id":payload["subsession_result"]["child_session_id"].as_str().unwrap_or(""),
        "work_title":title,"state":if retrying {"retrying"} else {"failed"},"reason_code":reason.code()});
    outbox::enqueue(
        db,
        (&key, &chat),
        &source,
        "work_failed",
        text,
        &payload,
        now,
    )?;
    db.execute(
        "UPDATE app_initiated_messages SET text=?1 WHERE source_key=?2",
        params![text, source],
    )
    .map_err(AppStorageError::sqlite)?;
    db.execute("UPDATE messages SET text=?1 WHERE id=(SELECT message_id FROM app_initiated_messages WHERE source_key=?2)", params![text,source]).map_err(AppStorageError::sqlite)?;
    outbox::update_payload(db, &source, &payload, now)
}

impl AppApplication {
    /// The visibility threshold is the bounded backoff cap (300 seconds).
    /// This runs only on startup or an explicit chat read, never on retry polls.
    pub(in crate::gateway::application) async fn surface_work_failures(
        &self,
        chat: Option<String>,
    ) -> Result<(), GatewayApplicationError> {
        let gate = self.initiated_gate().await?;
        let enqueued = self.storage.execute(move |db| {
            let chat_filter = if chat.is_some() { " AND chat_id=?2" } else { " AND ?2 IS NULL" };
            let sql = format!("SELECT id,reason FROM app_initiated_messages i WHERE state='held' AND kind='work_result' AND attempts>=?1{chat_filter} AND NOT EXISTS(SELECT 1 FROM app_initiated_messages n WHERE n.source_key='work-failed:'||i.source_key)");
            let mut query = db.prepare_cached(&sql).map_err(AppStorageError::sqlite)?;
            let ids = query.query_map(params![super::retry::CAPPED_ATTEMPTS,chat], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).map_err(AppStorageError::sqlite)?
                .collect::<Result<Vec<_>,_>>().map_err(AppStorageError::sqlite)?;
            drop(query);
            let enqueued = !ids.is_empty();
            for (id, reason) in ids {
                let reason = Reason::from_code(reason.as_deref().unwrap_or(""));
                enqueue(db, &id, &reason, &gate.language, true, &gate.now)?;
            }
            Ok(enqueued)
        }).await.map_err(app_error)?;
        if enqueued {
            self.automation_wake.notify_one();
        }
        Ok(())
    }
}

pub(in crate::gateway::application) fn save_reply_quiet(
    db: &Connection,
    turn: &str,
    facts: &AppSettingsFacts,
    now: &str,
) -> Result<(), AppStorageError> {
    let quiet = super::Gate::for_admission(db, facts, now)?.quiet()?;
    db.execute("UPDATE turns SET quiet=?1 WHERE id=?2 AND (json_type(execution_controls_json,'$.subsession_result')='object' OR json_type(execution_controls_json,'$.schedule_run')='object')", params![quiet,turn]).map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn withdraw(db: &Connection, id: &str) -> Result<(), AppStorageError> {
    db.execute("DELETE FROM app_initiated_messages WHERE source_key=(SELECT 'work-failed:'||source_key FROM app_initiated_messages WHERE id=?1) AND state='held'", [id]).map_err(AppStorageError::sqlite)?;
    Ok(())
}
