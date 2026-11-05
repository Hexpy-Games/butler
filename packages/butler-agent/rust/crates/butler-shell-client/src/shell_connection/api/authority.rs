use crate::{AuthorityDecision, AuthorityPage, AuthorityRequest, Error, ShellClient};
use reqwest::Method;
use serde_json::{Value, json};

impl ShellClient {
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
    /// GET /authority-permissions
    pub async fn get_authority_permissions(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["authority-permissions"], &[], None)
            .await
    }
    /// POST /authority-permissions/revoke
    pub async fn revoke_authority_permissions(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["authority-permissions", "revoke"],
            &[],
            Some(body),
        )
        .await
    }
    /// DELETE /authority-permissions/{grant_ref}?session_id
    pub async fn revoke_conversation_permission(
        &self,
        grant_ref: &str,
        session_id: &str,
    ) -> Result<Value, Error> {
        self.json(
            Method::DELETE,
            &["authority-permissions", grant_ref],
            &[("session_id", session_id.to_string())],
            None,
        )
        .await
    }
    /// GET /pending-asks?limit&before
    pub async fn get_pending_asks(
        &self,
        limit: Option<u32>,
        before: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = before {
            query.push(("before", value.to_string()));
        }
        self.json(Method::GET, &["pending-asks"], &query, None)
            .await
    }
    /// GET /sessions/{session_id}/pending-asks
    pub async fn get_session_pending_asks(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["sessions", session_id, "pending-asks"],
            &[],
            None,
        )
        .await
    }
    /// POST /sessions/{session_id}/pending-asks/{ask_id}/dismiss
    pub async fn dismiss_pending_ask(
        &self,
        session_id: &str,
        ask_id: &str,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "pending-asks", ask_id, "dismiss"],
            &[],
            None,
        )
        .await
    }
}
