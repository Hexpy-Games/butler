use crate::{Error, EventPage, MessagePage, Page, PageRequest, ShellClient};
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
    /// POST /messages with the full composer body (content parts, attachments, controls),
    /// as the app's `sendMessage` posts it.
    pub async fn post_message_body(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["messages"], &[], Some(body))
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
    /// GET /navigation
    pub async fn list_navigation(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["navigation"], &[], None).await
    }
    /// POST /sessions
    pub async fn create_session_with(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["sessions"], &[], Some(body))
            .await
    }
    /// PATCH /sessions/{session_id}
    pub async fn update_session(&self, session_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["sessions", session_id], &[], Some(body))
            .await
    }
    /// DELETE /sessions/{session_id}?permanent
    pub async fn delete_session_permanent(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::DELETE,
            &["sessions", session_id],
            &[("permanent", "true".into())],
            None,
        )
        .await
    }
    /// POST /sessions/{session_id}/archive
    pub async fn archive_session(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "archive"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /sessions/{session_id}/read
    pub async fn mark_session_read(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "read"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /sessions/{session_id}/composing
    pub async fn session_composing(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "composing"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /sessions/general/clear
    pub async fn clear_general(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", "general", "clear"],
            &[],
            Some(body),
        )
        .await
    }
    /// PATCH /sessions/{session_id}/controls
    pub async fn update_session_controls(
        &self,
        session_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::PATCH,
            &["sessions", session_id, "controls"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /sessions/{session_id}/plan-decisions/{plan_id}
    pub async fn decide_session_plan(
        &self,
        session_id: &str,
        plan_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "plan-decisions", plan_id],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /session-summary?session_id
    pub async fn get_session_summary(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["session-summary"],
            &[("session_id", session_id.to_string())],
            None,
        )
        .await
    }
    /// GET /context-details?session_id
    pub async fn get_context_details(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["context-details"],
            &[("session_id", session_id.to_string())],
            None,
        )
        .await
    }
    /// POST /messages
    pub async fn send_message(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["messages"], &[], Some(body))
            .await
    }
    /// GET /transcript-export?session_id
    pub async fn export_transcript(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["transcript-export"],
            &[("session_id", session_id.to_string())],
            None,
        )
        .await
    }
    /// GET /new-chat-briefing?date&project_id
    pub async fn get_new_chat_briefing(
        &self,
        date: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = date {
            query.push(("date", value.to_string()));
        }
        if let Some(value) = project_id {
            query.push(("project_id", value.to_string()));
        }
        self.json(Method::GET, &["new-chat-briefing"], &query, None)
            .await
    }
    /// GET /command-palette?query
    pub async fn search_command_palette(&self, query: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["command-palette"],
            &[("query", query.to_string())],
            None,
        )
        .await
    }
    /// GET /archives?limit&offset
    pub async fn list_archives(
        &self,
        limit: Option<u32>,
        offset: Option<u64>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = offset {
            query.push(("offset", value.to_string()));
        }
        self.json(Method::GET, &["archives"], &query, None).await
    }
    /// GET /work-status
    pub async fn get_work_status(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["work-status"], &[], None).await
    }
    /// GET /user-work
    pub async fn get_user_work(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["user-work"], &[], None).await
    }
    /// GET /sessions?kind&project_id&limit&cursor
    pub async fn list_sessions_filtered(
        &self,
        kind: Option<&str>,
        project_id: Option<&str>,
        page: crate::PageRequest,
    ) -> Result<Value, Error> {
        let mut query = vec![("limit", page.limit.to_string())];
        if let Some(kind) = kind {
            query.push(("kind", kind.into()));
        }
        if let Some(project_id) = project_id {
            query.push(("project_id", project_id.into()));
        }
        if let Some(cursor) = page.cursor {
            query.push(("cursor", cursor));
        }
        self.json(Method::GET, &["sessions"], &query, None).await
    }
}
