use crate::{
    AuthorityDecision, AuthorityPage, AuthorityRequest, Error, EventPage, MessagePage, Page,
    PageRequest, ShellClient,
};
use reqwest::Method;
use serde_json::{Value, json};

impl ShellClient {
    /// Read the session's effective permission, model and reasoning controls.
    pub async fn session_controls(&self, session: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["sessions", session, "controls"], &[], None)
            .await
    }

    /// Create a local chat and return the complete session record.
    pub async fn create_session(&self, title: Option<&str>) -> Result<Value, Error> {
        let mut body = json!({"kind":"chat", "workspace_mode":"local"});
        if let Some(title) = title {
            body["title"] = title.into();
        }
        self.json(Method::POST, &["sessions"], &[], Some(&body))
            .await
    }

    /// Read one page of chats; never fetches a full list internally.
    pub async fn list_chats(&self, page: PageRequest) -> Result<Page, Error> {
        self.list("chats", page).await
    }
    /// Read one page of complete session summaries.
    pub async fn list_sessions(&self, page: PageRequest) -> Result<Page, Error> {
        self.list("sessions", page).await
    }
    async fn list(&self, path: &str, page: PageRequest) -> Result<Page, Error> {
        let mut query = vec![("limit", page.limit.to_string())];
        if let Some(cursor) = page.cursor {
            query.push(("cursor", cursor));
        }
        self.json(Method::GET, &[path], &query, None).await
    }
    /// Read a bounded message window after a row cursor (0: latest window).
    /// The gateway bounds each page; continue with next_cursor until empty.
    pub async fn get_messages(&self, chat: &str, cursor: u64) -> Result<MessagePage, Error> {
        self.json(
            Method::GET,
            &["messages"],
            &[("chat_id", chat.into()), ("cursor", cursor.to_string())],
            None,
        )
        .await
    }
    /// Open a chat or read older messages using its opaque previous_cursor_token.
    /// Returns the complete session-view, including messages, message_window,
    /// latest turn and event cursor; each window has at most 200 messages.
    pub async fn message_window(
        &self,
        session: &str,
        before: Option<&str>,
        limit: u32,
    ) -> Result<Value, Error> {
        PageRequest::new(limit, None)?;
        let mut query = vec![("session_id", session.into()), ("limit", limit.to_string())];
        if let Some(before) = before {
            query.push(("before_cursor_token", before.into()));
        }
        self.json(Method::GET, &["session-view"], &query, None)
            .await
    }
    /// Submit a message using a stable caller-generated id for idempotency.
    /// The gateway starts its turn as part of this single atomic ingress.
    pub async fn post_message(
        &self,
        chat: &str,
        client_message_id: &str,
        text: &str,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["messages"],
            &[],
            Some(&json!({"chat_id":chat,"client_message_id":client_message_id,"text":text})),
        )
        .await
    }
    /// Start a turn through the same message ingress as the Electron app.
    pub async fn start_turn(
        &self,
        chat: &str,
        client_message_id: &str,
        text: &str,
    ) -> Result<Value, Error> {
        self.post_message(chat, client_message_id, text).await
    }
    /// Cancel a turn through /turns/{id}/cancel, with a JSON body.
    pub async fn cancel_turn(&self, id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["turns", id, "cancel"],
            &[],
            Some(&json!({})),
        )
        .await
    }
    /// Read pending authority cards, preserving exact action presentation.
    pub async fn authority_requests(&self, session: &str) -> Result<AuthorityPage, Error> {
        let raw: Value = self
            .json(
                Method::GET,
                &["authority-requests"],
                &[("session_id", session.into())],
                None,
            )
            .await?;
        let requests = raw
            .get("requests")
            .and_then(Value::as_array)
            .ok_or(Error::Protocol)?
            .iter()
            .map(|card| {
                Ok(AuthorityRequest {
                    request_ref: card
                        .get("request_ref")
                        .and_then(Value::as_str)
                        .ok_or(Error::Protocol)?
                        .into(),
                    reason: card
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    approval: card.get("approval").cloned().unwrap_or(Value::Null),
                    raw: card.clone(),
                })
            })
            .collect::<Result<_, Error>>()?;
        Ok(AuthorityPage { requests, raw })
    }
    /// Send the selected decision, without changing or inferring the action.
    pub async fn answer_authority(
        &self,
        session: &str,
        reference: &str,
        decision: AuthorityDecision,
    ) -> Result<Value, Error> {
        let (action, body) = match decision {
            AuthorityDecision::Allow { scope } => ("allow", json!({"scope":scope})),
            AuthorityDecision::Deny => ("deny", json!({})),
            AuthorityDecision::Modify { instruction } => {
                ("modify", json!({"instruction":instruction}))
            }
            AuthorityDecision::Answer(value) => ("answer", value),
        };
        self.json(
            Method::POST,
            &["authority-requests", reference, action],
            &[("session_id", session.into())],
            Some(&body),
        )
        .await
    }
    /// Read at most 200 durable events after cursor, including unknown kinds.
    pub async fn replay_events(&self, cursor: u64, limit: u32) -> Result<EventPage, Error> {
        PageRequest::new(limit, None)?;
        self.json(
            Method::GET,
            &["events"],
            &[("cursor", cursor.to_string()), ("limit", limit.to_string())],
            None,
        )
        .await
    }
}
