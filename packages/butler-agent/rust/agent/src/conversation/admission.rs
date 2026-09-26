mod classifier;
mod origin;
mod sanitizer;
mod state;

pub(crate) use classifier::{AdmissionSource, ConversationAdmissionInput};
pub(crate) use origin::{
    ConversationOriginFacts, classify_conversation_origin,
    conversation_session_id_for_durable_session,
};

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use indexmap::IndexSet;
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use super::types::*;
use super::{AgentConversationStore, ConversationError, ConversationResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AdmissionEventVisibility {
    Public,
    Internal,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RuntimeAdmissionEvent<'a> {
    pub kind: &'a str,
    pub payload: Option<&'a Map<String, Value>>,
    pub visibility: Option<AdmissionEventVisibility>,
}

pub(crate) type ConversationObserverFuture<'a> =
    Pin<Box<dyn Future<Output = ConversationResult<()>> + Send + 'a>>;

pub(crate) trait ConversationAdmissionObserver: Send + Sync {
    fn admission_metric<'a>(&'a self, metric: AdmissionMetric) -> ConversationObserverFuture<'a>;
    fn completion_observation<'a>(
        &'a self,
        observation: CompletionObservation,
    ) -> ConversationObserverFuture<'a>;
    fn completion_metric<'a>(&'a self, metric: CompletionMetric) -> ConversationObserverFuture<'a>;
}

#[derive(Clone, Debug)]
pub(crate) struct AdmissionMetric {
    pub session_id: String,
    pub session_role: String,
    pub source: AdmissionSource,
    pub event_kind: String,
    pub admitted: bool,
    pub class_name: &'static str,
    pub reason: &'static str,
}

#[derive(Clone, Debug)]
pub(crate) struct CompletionObservation {
    pub project_id: Option<String>,
    pub runtime_session_id: String,
    pub conversation_session_id: String,
    pub conversation_turn_id: String,
    pub inbound_message_id: String,
    pub outbound_message_id: String,
    pub outcome_generation: f64,
    pub completed_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct CompletionMetric {
    pub project_scoped: bool,
    pub succeeded: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct DurableSessionBinding {
    pub session_id: String,
    pub project_id: Option<String>,
    pub role: String,
    pub model_ref: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ConversationEnvelope {
    pub transport: String,
    pub event_id: String,
    pub message_text: String,
    pub content_parts: Option<Value>,
}

pub(crate) struct ConversationAdmissionTurnInput {
    pub store: AgentConversationStore,
    pub binding: DurableSessionBinding,
    pub envelope: ConversationEnvelope,
    pub turn_id: String,
    pub timestamp: String,
    pub origin: ConversationOriginDecision,
    pub observer: Arc<dyn ConversationAdmissionObserver>,
}

#[derive(Default)]
struct AdmissionState {
    known_tool_call_ids: HashSet<String>,
    evidence_refs: IndexSet<String>,
    tool_message_id: Option<String>,
    request_message_id: Option<String>,
    public_assistant_message_id: Option<String>,
}

pub(crate) struct ConversationAdmissionTurn {
    input: ConversationAdmissionTurnInput,
    turn: ConversationTurn,
    state: Mutex<AdmissionState>,
}

impl ConversationAdmissionTurn {
    pub(crate) async fn begin(input: ConversationAdmissionTurnInput) -> ConversationResult<Self> {
        if input.origin.reference.as_deref().is_none_or(str::is_empty)
            || !matches!(
                input.origin.kind,
                ConversationOriginKind::UserInput | ConversationOriginKind::InternalControl
            )
        {
            return Err(ConversationError::new(
                "conversation_origin_invalid",
                "prepared Conversation origin must be verified",
            ));
        }
        let existing = input
            .store
            .get_session_by_gateway_binding(&input.envelope.transport, &input.binding.session_id)
            .await?;
        let session_id = existing.map(|v| v.id).unwrap_or_else(|| {
            conversation_session_id_for_durable_session(&input.binding.session_id)
        });
        let turn = input
            .store
            .begin_turn(BeginTurnInput {
                gateway: input.envelope.transport.clone(),
                external_session_id: input.binding.session_id.clone(),
                session_id: Some(session_id),
                workspace_id: None,
                project_id: input.binding.project_id.clone(),
                actor: "user".into(),
                request_id: Some(input.envelope.event_id.clone()),
                turn_id: Some(input.turn_id.clone()),
                now: Some(input.timestamp.clone()),
            })
            .await?;
        Ok(Self {
            input,
            turn,
            state: Mutex::new(AdmissionState::default()),
        })
    }

    pub(crate) async fn admit_inbound(&self) -> ConversationResult<()> {
        self.apply(ConversationAdmissionInput {
            source: AdmissionSource::Gateway,
            kind: "inbound.accepted".into(),
            role: Some(ConversationRole::User),
            text: Some(self.input.envelope.message_text.clone()),
            source_gateway: Some(self.input.envelope.transport.clone()),
            source_ref: Some(self.input.envelope.event_id.clone()),
            payload: None,
            visibility: None,
            known_tool_call_ids: HashSet::new(),
        })
        .await
    }

    pub(crate) async fn record_event(
        &self,
        event: RuntimeAdmissionEvent<'_>,
    ) -> ConversationResult<()> {
        let known = self.state.lock().await.known_tool_call_ids.clone();
        self.apply(ConversationAdmissionInput {
            source: AdmissionSource::RuntimeTurnEvent,
            kind: event.kind.into(),
            role: None,
            text: None,
            source_gateway: Some(self.input.envelope.transport.clone()),
            source_ref: Some(format!("{}:{}", self.input.turn_id, event.kind)),
            payload: event.payload.cloned(),
            visibility: event.visibility,
            known_tool_call_ids: known,
        })
        .await
    }

    pub(crate) async fn admit_final(&self, text: &str, source_ref: &str) -> ConversationResult<()> {
        self.apply(ConversationAdmissionInput {
            source: AdmissionSource::Gateway,
            kind: "outbound.final".into(),
            role: Some(ConversationRole::Assistant),
            text: Some(text.into()),
            source_gateway: Some(self.input.envelope.transport.clone()),
            source_ref: Some(source_ref.into()),
            payload: None,
            visibility: None,
            known_tool_call_ids: HashSet::new(),
        })
        .await
    }

    pub(crate) async fn finalize(
        &self,
        status: &str,
        completed_at: &str,
    ) -> ConversationResult<()> {
        let (state_request, state_assistant, evidence) = {
            let state = self.state.lock().await;
            (
                state.request_message_id.clone(),
                state.public_assistant_message_id.clone(),
                state.evidence_refs.iter().cloned().collect::<Vec<_>>(),
            )
        };
        let existing = self.input.store.read_turn_outcome(&self.turn.id).await?;
        let generation = existing.as_ref().map(|v| v.generation).unwrap_or(0.0) + 1.0;
        let request =
            state_request.or_else(|| existing.as_ref().and_then(|v| v.request_message_id.clone()));
        let assistant = state_assistant.or_else(|| {
            existing
                .as_ref()
                .and_then(|v| v.public_assistant_message_id.clone())
        });
        let outcome = match status {
            "complete" => super::types::TurnOutcomeKind::Delivered,
            "aborted" => super::types::TurnOutcomeKind::Cancelled,
            _ => super::types::TurnOutcomeKind::Failed,
        };
        self.input
            .store
            .finalize_turn(FinalizeTurnInput {
                turn_id: self.turn.id.clone(),
                status: Some(status.into()),
                completed_at: Some(completed_at.into()),
                outcome_capsule: Some(TurnOutcomeCapsuleInput {
                    id: None,
                    session_id: self.turn.session_id.clone(),
                    turn_id: self.turn.id.clone(),
                    generation,
                    outcome,
                    request_message_id: request.clone(),
                    public_assistant_message_id: assistant.clone(),
                    provider_id: Some(provider_id(&self.input.binding.model_ref)),
                    model_ref: Some(self.input.binding.model_ref.clone()),
                    evidence_refs: evidence,
                    unresolved_obligations: vec![],
                    continuation: None,
                    safe_code: (status != "complete").then(|| format!("turn_{status}")),
                    created_at: Some(completed_at.into()),
                }),
            })
            .await?;
        if status == "complete"
            && let (Some(inbound), Some(outbound)) = (request, assistant)
        {
            let result = self
                .input
                .observer
                .completion_observation(CompletionObservation {
                    project_id: self.input.binding.project_id.clone(),
                    runtime_session_id: self.input.binding.session_id.clone(),
                    conversation_session_id: self.turn.session_id.clone(),
                    conversation_turn_id: self.turn.id.clone(),
                    inbound_message_id: inbound,
                    outbound_message_id: outbound,
                    outcome_generation: generation,
                    completed_at: completed_at.into(),
                })
                .await;
            let _ignored_metric = self
                .input
                .observer
                .completion_metric(CompletionMetric {
                    project_scoped: self.input.binding.project_id.is_some(),
                    succeeded: result.is_ok(),
                })
                .await;
        }
        Ok(())
    }
}

fn provider_id(model: &str) -> String {
    model.split('/').next().unwrap_or("").into()
}
fn collect_evidence(value: &Value, refs: &mut IndexSet<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|v| collect_evidence(v, refs)),
        Value::Object(object) => {
            for key in ["artifact_id", "packet_id", "digest"] {
                if let Some(value) = object
                    .get(key)
                    .and_then(Value::as_str)
                    .map(crate::public_text::trim_js_whitespace)
                    .filter(|v| !v.is_empty())
                {
                    refs.insert(value.into());
                }
            }
            object.values().for_each(|v| collect_evidence(v, refs));
        }
        _ => {}
    }
}
fn stringify_optional(value: Option<&Value>) -> ConversationResult<String> {
    match value {
        Some(value) => crate::json::stringify(value).map_err(ConversationError::json),
        None => Ok("null".into()),
    }
}
