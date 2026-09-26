//! Native BTCC Turn preparation in the source orchestration order.

mod context;
mod model;
mod origin;
mod request;
mod subsession;

use std::sync::Arc;

use serde_json::{Map, Value};

use super::{
    ConversationProjection, PortFuture, PreparedExecution, PreparedTurn, TurnPreparation, TurnStore,
};
use crate::btcc::storage::{BtccRepositories, WakeAuthorization};
use crate::btcc::{BtccError, ReasoningEffort, TurnRequest, TurnTrigger};
use crate::conversation::{
    AgentConversationStore, ConversationAdmissionObserver, ConversationAdmissionTurn,
    ConversationAdmissionTurnInput,
};
use crate::workspace::{SessionBindingStore, StoredSessionBinding};

pub(crate) trait AdmissionContextPort: Send + Sync {
    fn build_butler<'a>(
        &'a self,
        request: &'a TurnRequest,
        binding: &'a StoredSessionBinding,
    ) -> PortFuture<'a, ContextAssembly>;
    fn build_steward<'a>(
        &'a self,
        request: &'a TurnRequest,
        binding: &'a StoredSessionBinding,
    ) -> PortFuture<'a, ContextAssembly>;
    fn include_recent<'a>(
        &'a self,
        request: &'a TurnRequest,
        binding: &'a StoredSessionBinding,
        assembly: ContextAssembly,
    ) -> PortFuture<'a, ContextAssembly>;
}

pub(crate) trait AdmissionModelCatalogPort: Send + Sync {
    fn snapshot(
        &self,
        requested_model_refs: Vec<String>,
    ) -> PortFuture<'_, AdmissionModelCatalogSnapshot>;
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ContextSection {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) region: Option<String>,
    pub(crate) projection_class: String,
    pub(crate) scope_kind: String,
    pub(crate) source: Option<Value>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct ContextAssembly {
    pub(crate) static_context: Vec<ContextSection>,
    pub(crate) live_configuration: Vec<ContextSection>,
    pub(crate) runtime_state: Vec<ContextSection>,
    pub(crate) working_context: Vec<ContextSection>,
    pub(crate) retrieved_context: Vec<ContextSection>,
    pub(crate) current_input: Vec<ContextSection>,
    pub(crate) references: Vec<Value>,
    pub(crate) live_config_hash: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AdmissionModelMetadata {
    pub(crate) requested_model_ref: String,
    pub(crate) provider_id: String,
    pub(crate) provider_family_id: Option<String>,
    pub(crate) model_id: String,
    pub(crate) reasoning_efforts: Vec<ReasoningEffort>,
    pub(crate) default_reasoning_effort: ReasoningEffort,
    pub(crate) context_window_tokens: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AdmissionModelCatalogSnapshot {
    pub(crate) metadata: Vec<AdmissionModelMetadata>,
    pub(crate) retry_ceiling: Option<f64>,
}

pub(crate) struct DefaultTurnPreparation {
    binding_store: SessionBindingStore,
    conversation_store: AgentConversationStore,
    repositories: BtccRepositories,
    observer: Arc<dyn ConversationAdmissionObserver>,
    context: Arc<dyn AdmissionContextPort>,
    models: Arc<dyn AdmissionModelCatalogPort>,
}

impl DefaultTurnPreparation {
    pub(crate) fn new(
        binding_store: SessionBindingStore,
        conversation_store: AgentConversationStore,
        repositories: BtccRepositories,
        observer: Arc<dyn ConversationAdmissionObserver>,
        context: Arc<dyn AdmissionContextPort>,
        models: Arc<dyn AdmissionModelCatalogPort>,
    ) -> Self {
        Self {
            binding_store,
            conversation_store,
            repositories,
            observer,
            context,
            models,
        }
    }

    async fn prepare_owned(&self, request: TurnRequest) -> Result<PreparedExecution, BtccError> {
        if let Some(turn) = self
            .repositories
            .find_turn(&request.turn_id)
            .await
            .unwrap_or(None)
        {
            request::assert_replay_identity(&turn, &request)?;
            let binding = request::replay_binding(&turn, &request)?;
            let command = request::resume_command(&request);
            return self.finish(request, binding, command, false).await;
        }
        if let TurnTrigger::AuthorizedWake {
            source_turn_id,
            authorization_ref,
            result_scope_ref,
            ..
        } = &request.trigger
        {
            let authorized = self
                .repositories
                .validate_wake(WakeAuthorization {
                    source_turn_id: source_turn_id.clone(),
                    authorization_ref: authorization_ref.clone(),
                    result_scope_ref: result_scope_ref.clone(),
                })
                .await?;
            if !authorized {
                return Err(error(
                    "wake_authorization_denied",
                    "BTCC authorized wake denied",
                ));
            }
        }
        let binding = self
            .binding_store
            .get_by_session_id(&request.session_id)
            .await
            .map_err(|value| error(value.code, value.message))?
            .ok_or_else(|| {
                error(
                    "session_binding_missing",
                    format!(
                        "Missing stored BTCC session binding: {}",
                        request.session_id
                    ),
                )
            })?;
        request::assert_binding_role(&binding, &request)?;
        let subsession = subsession::read(&binding)?;
        let mut assembly = if subsession.is_some() {
            self.context.build_steward(&request, &binding).await?
        } else {
            self.context.build_butler(&request, &binding).await?
        };
        subsession::validate_assembly(&assembly, subsession.is_some())?;
        if subsession.is_none() {
            assembly = self
                .context
                .include_recent(&request, &binding, assembly)
                .await?;
        }
        let controls = request
            .execution_controls
            .as_ref()
            .map(super::super::execution_controls::ExecutionControls::verify)
            .transpose()?;
        let context = context::snapshot(
            &self.repositories,
            &binding,
            &request,
            &assembly,
            subsession.as_ref(),
            controls.as_ref(),
        )
        .await?;
        let refs = model::requested_refs(&binding, controls.as_ref())?;
        let catalog = self.models.snapshot(model::catalog_refs(&refs)).await?;
        let selection = model::admit(&binding, controls.as_ref(), &catalog)?;
        let command = request::fresh_command(&request, selection, context)?;
        self.finish(request, binding, command, true).await
    }

    async fn finish(
        &self,
        request: TurnRequest,
        binding: StoredSessionBinding,
        command: Value,
        is_fresh: bool,
    ) -> Result<PreparedExecution, BtccError> {
        let origin = origin::resolve(
            self.conversation_store.collation().as_ref(),
            &binding,
            &request,
        )?;
        let admission = ConversationAdmissionTurn::begin(ConversationAdmissionTurnInput {
            store: self.conversation_store.clone(),
            binding: request::conversation_binding(&binding),
            envelope: request::conversation_envelope(&request),
            turn_id: request.turn_id.clone(),
            timestamp: request.message.timestamp.clone(),
            origin,
            observer: Arc::clone(&self.observer),
        })
        .await
        .map_err(|value| error(value.code(), value.message()))?;
        admission
            .admit_inbound()
            .await
            .map_err(|value| error(value.code(), value.message()))?;
        let admission_input_hash = request::admission_hash(&command)?;
        let turn = PreparedTurn {
            preparation_id: request.turn_id.clone(),
            request,
            command,
            admission_input_hash,
            is_fresh,
        };
        let conversation = ConversationProjection::new(
            admission,
            self.conversation_store.clone(),
            turn.request.turn_id.clone(),
        );
        Ok(PreparedExecution {
            turn,
            conversation: Box::new(conversation),
        })
    }
}

impl TurnPreparation for DefaultTurnPreparation {
    fn prepare(&self, request: TurnRequest) -> PortFuture<'_, PreparedExecution> {
        Box::pin(self.prepare_owned(request))
    }
}

fn error(code: impl Into<String>, message: impl Into<String>) -> BtccError {
    BtccError::new(code, message)
}

fn object(value: Option<&Value>) -> &Map<String, Value> {
    match value.and_then(Value::as_object) {
        Some(value) => value,
        None => empty_object(),
    }
}
fn empty_object() -> &'static Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(Map::new)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests;
