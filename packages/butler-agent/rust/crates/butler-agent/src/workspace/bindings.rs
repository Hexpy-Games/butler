mod mutations;
mod reads;
pub(super) mod schema;
mod types;

pub(crate) use types::*;

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{WorkspaceError, WorkspaceResult};

const SESSION_COLUMNS: &str = "session_id, role, lifecycle_state, project_id, app_project_id, ledger_project_id, workspace_path, runtime_adapter_id, model_provider_id, model_ref, runtime_session_ref, provider_thread_ref, created_at, updated_at, last_active_at, metadata_json";

fn normalize_thread_id(value: Option<&str>) -> String {
    value
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .into()
}

fn dedupe_transport_bindings(
    bindings: Vec<SessionTransportBinding>,
) -> Vec<SessionTransportBinding> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(bindings.len());
    for binding in bindings {
        let thread_id = normalize_thread_id(binding.thread_id.as_deref());
        let key = format!(
            "{}\0{}\0{}\0{}",
            binding.transport, binding.account_id, binding.peer_id, thread_id
        );
        if seen.insert(key) {
            deduped.push(SessionTransportBinding {
                transport: binding.transport,
                account_id: binding.account_id,
                peer_id: binding.peer_id,
                thread_id: (!thread_id.is_empty()).then_some(thread_id),
            });
        }
    }
    deduped
}

fn encode_metadata(metadata: &Map<String, Value>) -> WorkspaceResult<String> {
    crate::json::stringify(&Value::Object(metadata.clone())).map_err(WorkspaceError::json)
}

fn parse_metadata(raw: Option<&String>) -> Option<Map<String, Value>> {
    let value = serde_json::from_str::<Value>(raw?).ok()?;
    value.as_object().cloned()
}
