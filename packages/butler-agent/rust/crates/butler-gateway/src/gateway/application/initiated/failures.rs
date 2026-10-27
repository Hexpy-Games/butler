//! One durable failure notice per result, shared by terminal and capped retries.
use super::{super::*, outbox};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub(super) enum Reason {
    HookBlocked,
    ModelUnavailable,
    InvalidRequest,
    Retrying,
    Unknown,
}
impl Reason {
    pub(super) fn from_error(error: &GatewayApplicationError) -> Self {
        match error {
            GatewayApplicationError::Public { code, .. } => match code.as_str() {
                "hook_blocked" => Self::HookBlocked,
                "session_model_unavailable" => Self::ModelUnavailable,
                "invalid_message_content" | "empty_queued_message" | "too_many_attachments" => {
                    Self::InvalidRequest
                }
                _ => Self::Unknown,
            },
            GatewayApplicationError::Internal { .. } => Self::Unknown,
        }
    }
    fn copy(&self, language: &str) -> (&'static str, &'static str) {
        let (code, ko, en) = match self {
            Self::HookBlocked => (
                "hook_blocked",
                "설정된 규칙에 의해 차단됨",
                "Blocked by a configured rule",
            ),
            Self::ModelUnavailable => (
                "session_model_unavailable",
                "모델을 사용할 수 없음",
                "Model unavailable",
            ),
            Self::InvalidRequest => (
                "invalid_request",
                "요청을 처리할 수 없음",
                "Unable to process the request",
            ),
            Self::Retrying => (
                "delivery_retrying",
                "계속 다시 시도하고 있어요",
                "Still retrying",
            ),
            Self::Unknown => ("unknown_error", "알 수 없는 오류", "Unknown error"),
        };
        (code, if language.starts_with("ko") { ko } else { en })
    }
}

pub(super) fn enqueue(
    db: &Connection,
    id: &str,
    reason: &Reason,
    language: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    let (chat, source, title, raw): (String, String, String, String) = db.query_row(
        "SELECT chat_id,source_key,text,payload_json FROM app_initiated_messages WHERE id=?1 AND kind='work_result'",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(AppStorageError::sqlite)?;
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let (code, label) = reason.copy(language);
    let text = if language.starts_with("ko") {
        format!("작업 결과를 전달하지 못했어요 · {label}")
    } else {
        format!("Couldn't deliver the work result · {label}")
    };
    let source = format!("work-failed:{source}");
    let key = format!(
        "work-failed-{}",
        butler_turn::btcc::digest_identity(&source)
    );
    outbox::enqueue(
        db,
        (&key, &chat),
        &source,
        "work_failed",
        &text,
        &json!({"work_session_id":payload["subsession_result"]["child_session_id"].as_str().unwrap_or(""),
            "work_title":title,"reason_code":code,"reason_label":label}),
        now,
    )
}

impl AppApplication {
    /// The visibility threshold is the bounded backoff cap (300 seconds).
    /// This runs only on startup or an explicit chat read, never on retry polls.
    pub(in crate::gateway::application) async fn surface_work_failures(
        &self,
        chat: Option<String>,
    ) -> Result<(), GatewayApplicationError> {
        let gate = self.initiated_gate().await?;
        self.storage.execute(move |db| {
            let chat_filter = if chat.is_some() { " AND chat_id=?2" } else { " AND ?2 IS NULL" };
            let sql = format!("SELECT id FROM app_initiated_messages i WHERE state='held' AND kind='work_result' AND attempts>=?1{chat_filter} AND NOT EXISTS(SELECT 1 FROM app_initiated_messages n WHERE n.source_key='work-failed:'||i.source_key)");
            let mut query = db.prepare_cached(&sql).map_err(AppStorageError::sqlite)?;
            let ids = query.query_map(params![super::retry::CAPPED_ATTEMPTS,chat], |r| r.get::<_,String>(0)).map_err(AppStorageError::sqlite)?
                .collect::<Result<Vec<_>,_>>().map_err(AppStorageError::sqlite)?;
            drop(query);
            for id in ids { enqueue(db, &id, &Reason::Retrying, &gate.language, &gate.now)?; }
            Ok(())
        }).await.map_err(app_error)?;
        self.automation_wake.notify_one();
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
