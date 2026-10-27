//! Registry read projection; no independent ask lifecycle or time expiry.
use super::contracts::{AuthorityError, AuthorityResult, PrincipalAuthority, RequestDecision};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PendingAsk {
    pub ask_id: String,
    pub kind: String,
    pub session_id: String,
    pub source_session_id: String,
    pub source_turn_id: String,
    pub source_message_id: Option<String>,
    pub source_call_id: Option<String>,
    pub deferred: bool,
    pub waiting_since: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_label: Option<String>,
    pub blocking: bool,
    pub state: String,
    pub created_at: String,
    pub actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_title: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PendingAskChange {
    pub seq: i64,
    pub owner: String,
    pub request_ref: String,
    pub kind: String,
    pub state: String,
}

impl PrincipalAuthority {
    pub async fn pending_asks(
        &self,
        owner: Option<String>,
        limit: usize,
        before: Option<String>,
    ) -> AuthorityResult<Vec<PendingAsk>> {
        let records = self
            .storage
            .pending_ask_records(owner, limit, before)
            .await
            .map_err(|e| AuthorityError::storage(e.code(), e.message()))??;
        records.into_iter().map(project).collect()
    }
    pub fn pending_ask_signal(&self) -> tokio::sync::watch::Receiver<()> {
        self.storage.subscribe_changes()
    }
    pub async fn pending_ask_changes(&self, after: i64) -> AuthorityResult<Vec<PendingAskChange>> {
        self.storage
            .pending_ask_changes(after)
            .await
            .map_err(|e| AuthorityError::storage(e.code(), e.message()))?
    }
    pub async fn ack_pending_asks(&self, through: i64) -> AuthorityResult<()> {
        self.storage
            .ack_pending_asks(through)
            .await
            .map_err(|e| AuthorityError::storage(e.code(), e.message()))
    }
    pub async fn dismiss_pending_question(
        &self,
        owner: String,
        reference: String,
    ) -> AuthorityResult<bool> {
        let receipt = serde_json::json!({"status":"dismissed","message_id":format!("dismiss-{}",(self.uuid)())}).to_string();
        self.storage
            .dismiss_pending_question(owner, reference, receipt, (self.clock)())
            .await
            .map_err(|e| AuthorityError::storage(e.code(), e.message()))
    }
}

pub(super) fn project(r: super::contracts::AuthorityRecord) -> AuthorityResult<PendingAsk> {
    let question = r.capability == "ask_user";
    let blocking = r.decision == RequestDecision::Pending;
    let title = if question {
        let questions: super::questions::UserQuestions =
            serde_json::from_str(&r.normalized_input_json)
                .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?;
        questions
            .questions
            .into_iter()
            .map(|q| q.title)
            .collect::<Vec<_>>()
            .join(" · ")
    } else {
        r.reason
    };
    let kind = if question { "question" } else { "approval" };
    let actions = if question {
        if blocking {
            vec!["open", "answer"]
        } else {
            vec!["open", "answer", "dismiss"]
        }
    } else {
        vec!["open", "allow", "deny"]
    };
    Ok(PendingAsk {
        ask_id: format!("{kind}:{}", r.request_ref),
        kind: kind.into(),
        session_id: r.owner_session_id,
        source_session_id: r.source_session_id,
        source_turn_id: r.source_turn_id,
        source_message_id: None,
        source_call_id: r.source_call_id,
        deferred: question && !blocking,
        waiting_since: if question && !blocking {
            r.updated_at
        } else {
            r.created_at.clone()
        },
        title,
        summary: None,
        target_label: None,
        blocking,
        state: "open".into(),
        created_at: r.created_at,
        actions: actions.into_iter().map(str::to_owned).collect(),
        session_title: None,
    })
}

impl PrincipalAuthority {
    /// Authority-owned entries; the host can combine independent reminder sources.
    pub async fn ask_reminders(
        &self,
        owner: String,
        turn: String,
    ) -> AuthorityResult<Vec<serde_json::Value>> {
        let records = self
            .storage
            .ask_reminder_records(owner, turn)
            .await
            .map_err(|e| AuthorityError::storage(e.code(), e.message()))??;
        records
            .into_iter()
            .map(|r| {
                let receipt = r
                    .outcome_receipt_json
                    .as_deref()
                    .map(serde_json::from_str::<serde_json::Value>)
                    .transpose()
                    .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?;
                let resolved_at = r.updated_at.clone();
                let ask = project(r)?;
                Ok(serde_json::json!({"ask_id":ask.ask_id,"kind":ask.kind,
                "title":ask.title.chars().take(160).collect::<String>(),
                "created_at":ask.created_at,"resolved_at":receipt.as_ref().map(|_|resolved_at),
                "response":receipt.as_ref().map(reminder_response)}))
            })
            .collect()
    }
}

fn reminder_response(receipt: &serde_json::Value) -> serde_json::Value {
    let answer = receipt
        .get("answers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|a| a.get("skipped").and_then(serde_json::Value::as_bool) != Some(true))
        .flat_map(|a| {
            a.get("selected")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str)
                .chain(a.get("custom").and_then(serde_json::Value::as_str))
        })
        .collect::<Vec<_>>()
        .join(" · ");
    let mut summary = answer.chars().take(160).collect::<String>();
    if answer.chars().count() > 160 {
        summary.pop();
        summary.push('…');
    }
    serde_json::json!({"status":receipt.get("status"),"answer":summary})
}
