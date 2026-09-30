//! Native session admission prepared before either service listener starts.

use std::sync::Arc;

use butler_gateway::gateway::{InboundQueue, TranscriptWriter};
use butler_turn::btcc::BtccError;
use serde_json::json;

use super::support::failure;
use crate::host::service::{
    delivery::AppDelivery, ingress::IngressDispatcher, instance::InstanceGuard,
    restart_handoff::RestartHandoff,
};
use crate::host::{AgentRuntime, ProgressPublisher, ServiceConfiguration, require_model_ref};

pub(super) struct Admission {
    pub session_id: String,
    pub model: String,
    pub progress: Arc<ProgressPublisher>,
    pub queue: Arc<InboundQueue>,
    pub dispatcher: IngressDispatcher,
}

pub(super) async fn prepare(
    runtime: &AgentRuntime,
    config: &ServiceConfiguration,
    writer: Arc<TranscriptWriter>,
    instance: &InstanceGuard,
) -> Result<Admission, BtccError> {
    let bootstrap = config
        .bootstrap_butler_session(&runtime.bindings, &runtime.collation)
        .await?;
    let binding = bootstrap.binding;
    if bootstrap.newly_registered {
        writer
            .append_lifecycle(
                binding.session_id.clone(),
                "butler".into(),
                "active".into(),
                Some("native-butler-bootstrap".into()),
                json!({"projectId":binding.project_id,"workspacePath":binding.workspace_path}),
            )
            .await
            .map_err(|e| failure(e.code(), e.message()))?;
    }
    config.persist_session_pointer(&binding.session_id)?;
    let model = require_model_ref(&binding)?.to_owned();
    let progress = Arc::new(ProgressPublisher::new(
        runtime.progress.clone(),
        writer.clone(),
    ));
    let queue = runtime.inbound_queue.clone();
    let restart_handoff = Arc::new(RestartHandoff::new(
        runtime.restart_tool_journal.clone(),
        runtime.restart_effect_journal.clone(),
        config.installation.clone(),
        config.data_root.clone(),
        instance.restart_identity(),
    ));
    super::recover_inbound_queue(queue.clone()).await?;
    let dispatcher = IngressDispatcher::new(
        queue.clone(),
        runtime.btcc.clone(),
        runtime.authority.clone(),
        runtime.bindings.clone(),
        config.data_root.clone(),
        config.data_root.clone(),
        Arc::new(AppDelivery::new(writer, progress.clone())),
        runtime.subsessions.clone(),
        restart_handoff,
    );
    Ok(Admission {
        session_id: binding.session_id,
        model,
        progress,
        queue,
        dispatcher,
    })
}
