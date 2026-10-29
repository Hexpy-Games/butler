//! Read projection across independent authority and canon ask owners.
pub(super) mod events;
pub(super) mod metadata;
use super::{AppApplication, GatewayApplicationError, app_error, storage::AppStorageError};
use butler_turn::btcc::PendingAsk;
pub(super) use events::start;
use serde_json::{Value, json};

pub(super) const CHAT: &str =
    "SELECT title,archived FROM chats INDEXED BY sqlite_autoindex_chats_1 WHERE id=?1";

impl AppApplication {
    pub(super) async fn pending_asks_owned(
        &self,
        session: Option<String>,
        limit: usize,
        before: Option<String>,
    ) -> Result<Value, GatewayApplicationError> {
        if !(1..=200).contains(&limit) || before.as_deref().is_some_and(|s| !valid_cursor(s)) {
            return Err(public(400, "invalid_cursor", "Invalid pending asks page."));
        }
        let owner = match &session {
            Some(session) => Some(self.runtime_hint(session).await?),
            None => None,
        };
        let mut asks = self
            .authority_ask_page(owner.clone(), limit + 1, before.clone())
            .await?;
        let language = super::canon_proposals::language(self).await?;
        let canon = self
            .dependencies
            .canon
            .proposal(
                "open".into(),
                json!({"session_id":owner,"limit":limit+1,"before":before,"language":language}),
            )
            .await?;
        let canon: Vec<PendingAsk> =
            serde_json::from_value(canon).map_err(GatewayApplicationError::internal_from)?;
        asks.extend(
            self.storage
                .read(move |db| metadata::decorate(db, canon))
                .await
                .map_err(app_error)?,
        );
        asks.sort_by(|a, b| (&b.created_at, &b.ask_id).cmp(&(&a.created_at, &a.ask_id)));
        if let Some(session) = session {
            for ask in &mut asks {
                ask.session_title = None;
            }
            Ok(json!({"session_id":session,"open_count":asks.len(),"asks":asks}))
        } else {
            let more = asks.len() > limit;
            asks.truncate(limit);
            let cursor = more.then(|| asks.last().map(cursor)).flatten();
            Ok(json!({"asks":asks,"next_cursor":cursor}))
        }
    }

    pub(super) async fn dismiss_pending_ask_owned(
        &self,
        session: String,
        ask_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        if ask_id.starts_with("approval:") {
            return Err(public(409, "approval_card_only", "Use the approval card."));
        }
        if let Some(id) = ask_id.strip_prefix("canon:") {
            return super::canon_proposals::resolve(
                self,
                json!({"id":id,"session_id":session,"outcome":"dropped","by":"card"}),
            )
            .await;
        }
        let Some(reference) = ask_id.strip_prefix("question:") else {
            return Err(public(
                409,
                "ask_not_dismissible",
                "This ask cannot be dismissed.",
            ));
        };
        let owner = self.runtime_hint(&session).await?;
        if !self
            .dependencies
            .authority_handoff
            .dismiss_pending_question(owner, reference.into())
            .await?
        {
            return Err(public(404, "ask_not_found", "Open question not found."));
        }
        Ok(json!({"dismissed":true}))
    }
}

fn valid_cursor(cursor: &str) -> bool {
    cursor
        .split_once('|')
        .is_some_and(|(time, id)| !time.is_empty() && !id.is_empty())
}
fn cursor(ask: &PendingAsk) -> String {
    format!("{}|{}", ask.created_at, ask.ask_id)
}
fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}

impl crate::gateway::GatewayPendingAsks for AppApplication {
    fn pending_asks(
        &self,
        session: Option<String>,
        limit: usize,
        before: Option<String>,
    ) -> crate::gateway::ApplicationFuture<Value> {
        let app = self.clone_handle();
        Box::pin(async move { app.pending_asks_owned(session, limit, before).await })
    }
    fn dismiss_pending_ask(
        &self,
        session: String,
        ask_id: String,
    ) -> crate::gateway::ApplicationFuture<Value> {
        let app = self.clone_handle();
        Box::pin(async move { app.dismiss_pending_ask_owned(session, ask_id).await })
    }
}

impl AppApplication {
    pub(super) async fn load_pending_ask_attention(
        &self,
        sessions: &mut [super::AppSessionSummary],
    ) -> Result<(), GatewayApplicationError> {
        let mut attention = std::collections::HashSet::new();
        let mut own = std::collections::HashSet::new();
        for (owner, own_ask) in self
            .dependencies
            .authority_handoff
            .attention_sessions(sessions.iter().map(|s| s.session_hint.clone()).collect())
            .await?
        {
            if own_ask {
                own.insert(owner.clone());
            }
            attention.insert(owner);
        }
        let canon = self
            .dependencies
            .canon
            .proposal(
                "attention".into(),
                json!({"sessions":sessions.iter().map(|s|&s.session_hint).collect::<Vec<_>>()}),
            )
            .await?;
        // Canon proposals are the conversation's own asks.
        for owner in canon
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            own.insert(owner.to_owned());
            attention.insert(owner.to_owned());
        }
        for session in sessions {
            session.attention_required = attention.contains(&session.session_hint);
            let delegated = session
                .subtasks
                .iter()
                .any(|subtask| subtask.state == butler_turn::btcc::SubtaskState::NeedsApproval);
            session.attention_source = attention_source(
                session.attention_required,
                own.contains(&session.session_hint),
                delegated,
            );
        }
        Ok(())
    }
}

/// Attention no subtask row shows stays the conversation's own, so the
/// parent row keeps its mark whenever nothing else would.
fn attention_source(required: bool, own: bool, delegated: bool) -> Option<&'static str> {
    match (required, own || !delegated, delegated) {
        (false, _, _) => None,
        (true, true, true) => Some("both"),
        (true, true, false) => Some("self"),
        (true, false, _) => Some("subtask"),
    }
}
