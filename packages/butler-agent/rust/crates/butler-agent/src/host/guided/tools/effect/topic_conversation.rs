//! Reviewed, idempotent App request for a new topic conversation.

use std::{sync::Arc, time::Duration};

use http::Method;
use serde_json::{Map, Value};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::host::app::self_api::{SelfApi, SelfApiError, SelfBodyError};

use crate::host::{ActiveAppEndpoint, GuidedTools};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AdapterOutcome, EffectAdapter, EffectAdapterError, EffectFailure, EffectFuture, PlanBinding,
};

const CAPABILITY: &str = "start_topic_conversation";
const SOURCE_TARGET: &str = "conversation-branch";

pub(super) fn supports(name: &str) -> bool {
    name == CAPABILITY
}

pub(super) fn prepare(
    owner: &GuidedTools,
    call: &butler_turn::btcc::ModelRoundToolCall,
    _occurrence: &str,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), butler_turn::btcc::BtccError> {
    if owner.binding.app_session_id.is_none() {
        return Err(butler_turn::btcc::BtccError::relayed(
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
            endpoint: owner.app_endpoint.clone(),
            current_session_id: owner.binding.app_session_id.clone(),
            target,
        }),
    ))
}

struct TopicConversationEffect {
    endpoint: Arc<ActiveAppEndpoint>,
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
            .map_err(|source| policy("branch_input_invalid").with_source(source))
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
        _: Option<&'a butler_turn::btcc::EffectError>,
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

fn normalize(
    input: &Map<String, Value>,
) -> Result<Map<String, Value>, butler_turn::btcc::BtccError> {
    let invalid = || {
        butler_turn::btcc::BtccError::relayed(
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
            return Ok(unavailable(reconciling));
        };
        let auth = current.local_auth;
        if auth.required && auth.token().is_none() {
            return Ok(AdapterOutcome::NotApplied(adapter(
                "app_local_auth_unconfigured",
            )));
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
        let body = Value::Object(body);
        let api = SelfApi::new(&self.endpoint);
        let deadline = Instant::now() + Duration::from_secs(60);
        let sent = tokio::select! {
            biased;
            () = signal.cancelled() => return Ok(AdapterOutcome::Uncertain(Some(adapter("branch_outcome_unknown")))),
            result = api.request(Method::POST, "/internal/session-branches", Some(&body), None, Some(deadline)) => result,
        };
        let response = match sent {
            Ok(response) => response,
            Err(SelfApiError::Unavailable) => return Ok(unavailable(reconciling)),
            Err(SelfApiError::Unknown) => {
                return Ok(AdapterOutcome::Uncertain(Some(adapter(
                    "branch_outcome_unknown",
                ))));
            }
        };
        let status = response.status();
        let decoded = tokio::select! {
            biased;
            () = signal.cancelled() => return Ok(AdapterOutcome::Uncertain(Some(adapter("branch_outcome_unknown")))),
            result = response.bytes() => result,
        };
        branch_outcome(status, decoded)
    }
}

fn unavailable(reconciling: bool) -> AdapterOutcome {
    let failure = adapter("app_gateway_unavailable");
    if reconciling {
        AdapterOutcome::Uncertain(Some(failure))
    } else {
        AdapterOutcome::NotApplied(failure)
    }
}

fn branch_outcome(
    status: http::StatusCode,
    bytes: Result<bytes::Bytes, SelfBodyError>,
) -> Result<AdapterOutcome, EffectFailure> {
    let Some(payload) = bytes
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
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
        .map_err(|error| EffectFailure::adapter(error.to_string()).with_source(error))
}
