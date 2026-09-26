//! Reviewed, idempotent App request for a new topic conversation.

use std::{sync::Arc, time::Duration};

use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::{
    btcc::{
        AdapterOutcome, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture, PlanBinding,
    },
    host::{NativeActiveAppEndpoint, NativeGuidedTools},
    json::JsonDocument,
};

const CAPABILITY: &str = "start_topic_conversation";
const SOURCE_TARGET: &str = "conversation-branch";

pub(super) fn supports(name: &str) -> bool {
    name == CAPABILITY
}

pub(super) fn prepare(
    owner: &NativeGuidedTools,
    call: &crate::btcc::ModelRoundToolCall,
    _occurrence: &str,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), crate::btcc::BtccError> {
    if owner.binding.app_session_id.is_none() {
        return Err(crate::btcc::BtccError::relayed(
            "branch_source_required",
            "This Turn is not bound to an App conversation.",
        ));
    }
    let normalized = normalize(&call.arguments)?;
    let target = SOURCE_TARGET.to_owned();
    Ok((
        target.clone(),
        Value::Object(normalized),
        Arc::new(TopicConversationEffect {
            client: reqwest::Client::new(),
            endpoint: owner.app_endpoint.clone(),
            current_session_id: owner.binding.app_session_id.clone(),
            target,
        }),
    ))
}

struct TopicConversationEffect {
    client: reqwest::Client,
    endpoint: Arc<NativeActiveAppEndpoint>,
    current_session_id: Option<String>,
    target: String,
}

impl EffectAdapter for TopicConversationEffect {
    fn capability(&self) -> &str {
        CAPABILITY
    }

    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }

    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        (target == self.target)
            .then(|| self.target.clone())
            .ok_or_else(|| policy("branch_target_mismatch"))
    }

    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)?;
        Ok("새 대화".into())
    }

    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        let Some(object) = input.as_object() else {
            return Err(policy("branch_input_invalid"));
        };
        normalize(object)
            .map(Value::Object)
            .map_err(|_| policy("branch_input_invalid"))
    }

    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        idempotency_key: &'a str,
        signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if target != self.target {
                return Ok(AdapterOutcome::NotApplied(adapter(
                    "branch_target_mismatch",
                )));
            }
            self.request(input, idempotency_key, signal, false).await
        })
    }

    fn reconcile<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        idempotency_key: &'a str,
        signal: &'a CancellationToken,
        attempts: i64,
        _: Option<&'a crate::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if attempts <= 0 {
                return Ok(AdapterOutcome::NotApplied(adapter("branch_not_dispatched")));
            }
            if target != self.target {
                return Ok(AdapterOutcome::Uncertain(Some(adapter(
                    "branch_target_mismatch",
                ))));
            }
            // Re-posting the same App request id recovers its prepared/ready row and
            // never reserves a second session or sends follow_up under a new key.
            self.request(input, idempotency_key, signal, true).await
        })
    }
}

fn normalize(input: &Map<String, Value>) -> Result<Map<String, Value>, crate::btcc::BtccError> {
    let invalid = || {
        crate::btcc::BtccError::relayed(
            "branch_input_invalid",
            "Topic conversation inputs are invalid.",
        )
    };
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(invalid)?;
    let destination = input
        .get("destination")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if !matches!(destination, "chat" | "project" | "new_project")
        || destination == "project"
            && input
                .get("project_id")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
        || ["source_session_id", "source_message_id", "project_id"]
            .iter()
            .any(|key| {
                input
                    .get(*key)
                    .is_some_and(|value| !value.is_null() && !value.is_string())
            })
        || input
            .get("follow_up")
            .is_some_and(|value| !value.is_string())
        || input.keys().any(|key| {
            !matches!(
                key.as_str(),
                "title"
                    | "source_session_id"
                    | "source_message_id"
                    | "destination"
                    | "project_id"
                    | "follow_up"
            )
        })
    {
        return Err(invalid());
    }
    let mut normalized = Map::new();
    normalized.insert("title".into(), Value::String(title.to_owned()));
    normalized.insert("destination".into(), Value::String(destination.to_owned()));
    for key in [
        "source_session_id",
        "source_message_id",
        "project_id",
        "follow_up",
    ] {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            normalized.insert(key.to_owned(), value.clone());
        }
    }
    Ok(normalized)
}

fn policy(code: &str) -> EffectFailure {
    EffectFailure::policy(
        code.to_owned(),
        "Topic conversation effect identity is invalid.",
    )
}

fn adapter(code: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, "The topic conversation outcome is unavailable.")
}

impl TopicConversationEffect {
    async fn request(
        &self,
        input: &Value,
        request_id: &str,
        signal: &CancellationToken,
        reconciling: bool,
    ) -> Result<AdapterOutcome, EffectFailure> {
        if signal.is_cancelled() {
            return Ok(AdapterOutcome::NotApplied(adapter("branch_cancelled")));
        }
        let Some(current_session_id) = self.current_session_id.as_deref() else {
            return Ok(AdapterOutcome::NotApplied(adapter(
                "branch_source_required",
            )));
        };
        if request_id.trim().is_empty() {
            return Ok(AdapterOutcome::NotApplied(adapter(
                "branch_request_identity_required",
            )));
        }

        // Use the currently active owner, never pending persisted configuration.
        let Some(current) = self.endpoint.snapshot() else {
            let failure = adapter("app_gateway_unavailable");
            return Ok(if reconciling {
                AdapterOutcome::Uncertain(Some(failure))
            } else {
                AdapterOutcome::NotApplied(failure)
            });
        };
        let auth = current.local_auth;
        if auth.required && auth.token().is_none() {
            return Ok(AdapterOutcome::NotApplied(adapter(
                "app_local_auth_unconfigured",
            )));
        }
        let url = format!("{}/internal/session-branches", current.base_url);
        let mut request = self
            .client
            .post(url)
            .timeout(Duration::from_secs(60))
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        if let Some(token) = auth.token() {
            request = request.bearer_auth(token);
        }
        let mut body = input
            .as_object()
            .cloned()
            .ok_or_else(|| policy("branch_input_invalid"))?;
        body.insert("request_id".into(), Value::String(request_id.to_owned()));
        body.insert(
            "current_session_id".into(),
            Value::String(current_session_id.to_owned()),
        );
        let sent = tokio::select! {
            biased;
            () = signal.cancelled() => return Ok(AdapterOutcome::Uncertain(Some(adapter("branch_outcome_unknown")))),
            result = request.json(&Value::Object(body)).send() => result,
        };
        let Ok(response) = sent else {
            return Ok(AdapterOutcome::Uncertain(Some(adapter(
                "branch_outcome_unknown",
            ))));
        };
        let status = response.status();
        let decoded = tokio::select! {
            biased;
            () = signal.cancelled() => return Ok(AdapterOutcome::Uncertain(Some(adapter("branch_outcome_unknown")))),
            result = response.json::<Value>() => result,
        };
        let Ok(payload) = decoded else {
            return Ok(AdapterOutcome::Uncertain(Some(adapter(
                "branch_response_invalid",
            ))));
        };
        if !status.is_success() {
            let error = payload
                .get("error")
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("branch_request_failed");
            let failure = adapter(error);
            return Ok(if status.is_client_error() {
                AdapterOutcome::NotApplied(failure)
            } else {
                AdapterOutcome::Uncertain(Some(failure))
            });
        }
        let Some(data) = payload.get("data").filter(|value| value.is_object()) else {
            return Ok(AdapterOutcome::Uncertain(Some(adapter(
                "branch_response_invalid",
            ))));
        };
        JsonDocument::from_value(data)
            .map(AdapterOutcome::Applied)
            .map_err(|error| EffectFailure::adapter(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_branch_accepted_plan_uses_source_target() {
        let effect = TopicConversationEffect {
            client: reqwest::Client::new(),
            endpoint: Arc::new(NativeActiveAppEndpoint::new()),
            current_session_id: Some("app-session".into()),
            target: SOURCE_TARGET.into(),
        };

        assert_eq!(effect.binding(), PlanBinding::AcceptedPlan);
        assert_eq!(
            effect.normalize_target(SOURCE_TARGET).unwrap(),
            SOURCE_TARGET
        );
        assert_eq!(effect.sanitize_target(SOURCE_TARGET).unwrap(), "새 대화");
        assert!(effect.normalize_target("session-branch:tool-1").is_err());
    }
}
