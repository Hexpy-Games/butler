//! App session binding mutation and runtime policy.

use super::{Envelope, NativeIngressError};
use crate::workspace::{
    OwnOptional, SessionBindingStore, SessionLifecycleState, SessionRole, SessionTransportBinding,
    StoredSessionBinding, UpsertSessionBinding,
};
use serde_json::{Value, json};
use std::path::Path;

pub(super) struct BindingRoots<'a> {
    pub data_root: &'a Path,
    pub default_workspace: &'a Path,
}

pub(super) async fn upsert_app_binding(
    store: &SessionBindingStore,
    existing: Option<StoredSessionBinding>,
    envelope: &Envelope,
    context: &Value,
    session_id: &str,
    model_ref: &str,
    roots: BindingRoots<'_>,
) -> Result<StoredSessionBinding, NativeIngressError> {
    let BindingRoots {
        data_root,
        default_workspace,
    } = roots;
    let project = context.get("project");
    let project_id = project
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let ledger_id = project
        .and_then(|value| value.get("ledgerProjectId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let project_workspace = project
        .and_then(|value| value.get("workspacePath"))
        .and_then(Value::as_str);
    let marked = existing
        .as_ref()
        .and_then(|binding| binding.metadata.as_ref())
        .is_some_and(|metadata| metadata.contains_key("sessionWorkspace"));
    let workspace = if marked {
        existing
            .as_ref()
            .map(|binding| binding.workspace_path.as_str())
    } else {
        project_workspace.or_else(|| {
            existing
                .as_ref()
                .map(|binding| binding.workspace_path.as_str())
        })
    }
    .filter(|value| !value.is_empty())
    .map(str::to_owned)
    .unwrap_or_else(|| default_workspace.to_string_lossy().into_owned());
    let access = envelope
        .execution_controls
        .as_ref()
        .and_then(|value| value.as_json().get("access_mode"))
        .and_then(Value::as_str)
        .unwrap_or("read_only");
    let has_project = project_id.is_some();
    let profiles: &[&str] = if access == "full_access" {
        if has_project {
            &["workspace", "project", "project-lifecycle"]
        } else {
            &["workspace"]
        }
    } else if has_project {
        &["project"]
    } else {
        &[]
    };
    let session_kind = context
        .pointer("/session/kind")
        .and_then(Value::as_str)
        .unwrap_or("chat");
    let source = if has_project {
        "app_project_default"
    } else if session_kind == "project" {
        "project_shell_default"
    } else {
        "session_default"
    };
    let butler_role = existing
        .as_ref()
        .is_none_or(|binding| matches!(binding.role, SessionRole::Butler));
    let selected_memory_write = existing
        .as_ref()
        .and_then(|binding| binding.metadata.as_ref())
        .is_some_and(|metadata| {
            [
                metadata.get("requiredNativeToolProfiles"),
                metadata
                    .get("runtimePolicy")
                    .and_then(|policy| policy.get("requiredNativeToolProfiles")),
            ]
            .into_iter()
            .flatten()
            .filter_map(Value::as_array)
            .flatten()
            .any(|profile| profile.as_str() == Some("memory-write"))
        });
    let mut metadata = existing
        .as_ref()
        .and_then(|binding| binding.metadata.clone())
        .unwrap_or_default();
    if selected_memory_write {
        let profiles = metadata
            .entry("requiredNativeToolProfiles")
            .or_insert_with(|| json!([]));
        if let Some(profiles) = profiles.as_array_mut()
            && !profiles
                .iter()
                .any(|profile| profile.as_str() == Some("memory-write"))
        {
            profiles.push(json!("memory-write"));
        }
    }
    metadata.insert("source".into(), "native-butler-queued-app-context".into());
    metadata.insert("appSessionKind".into(), session_kind.into());
    metadata.insert("accessMode".into(), access.into());
    let Some(controls) = envelope.execution_controls.as_ref() else {
        return Err(NativeIngressError::new(
            "session_binding_unavailable",
            "Verified execution controls are missing",
        ));
    };
    let controls = controls.as_json();
    metadata.insert(
        "reasoning_effort".into(),
        controls
            .get("reasoning_effort")
            .cloned()
            .unwrap_or(Value::Null),
    );
    metadata.insert(
        "plan_mode".into(),
        controls.get("plan_mode").cloned().unwrap_or(Value::Null),
    );
    metadata.insert("turnExecutionControls".into(), controls.clone());
    if let Some(plan) = context.get("planId") {
        metadata.insert("plan_id".into(), plan.clone());
    }
    let mut policy = json!({
        "accessMode":access,
        "trackingModeSource":source,"tracking_mode_source":source,
        "closeoutStrategy":if has_project{"ledger"}else{"session_ledger"},
        "closeout_strategy":if has_project{"ledger"}else{"session_ledger"},
        "thinFirstResponse":true,"thin_first_response":true,
        "requiredNativeTools":[],"required_tools":[],"requiredNativeToolProfiles":profiles,
    });
    if access == "full_access" {
        let onboarding_active = butler_role
            && !crate::profile::first_chat_onboarding_complete(
                data_root,
                &crate::models::ModelConfigurationClock::now_iso(&crate::host::SystemIdentity),
            );
        let mut selected = Vec::new();
        if onboarding_active || selected_memory_write {
            selected.push("update_onboarding_profile");
        }
        if onboarding_active || selected_memory_write {
            selected.push("summarize_user_profile");
        }
        if selected_memory_write {
            selected.push("ingest_task_memory");
            selected.push("update_explicit_memory");
        }
        if super::image_admission::admits_zai_image_tool(envelope) {
            selected.push("analyze_attached_image");
        }
        policy["requiredNativeTools"] = json!(selected);
    }
    if has_project {
        policy["trackingMode"] = "ledger".into();
        policy["tracking_mode"] = "ledger".into();
    } else {
        policy["workLedgerScope"] = "session".into();
        policy["work_ledger_scope"] = "session".into();
    }
    metadata.insert("runtimePolicy".into(), policy);
    let mut transport_bindings = existing
        .as_ref()
        .map(|binding| binding.transport_bindings.clone())
        .unwrap_or_default();
    transport_bindings.retain(|binding| {
        !(binding.transport == envelope.transport
            && binding.account_id == envelope.account_id
            && binding.peer_id == envelope.peer.id
            && binding.thread_id.is_none())
    });
    transport_bindings.push(SessionTransportBinding {
        transport: envelope.transport.clone(),
        account_id: envelope.account_id.clone(),
        peer_id: envelope.peer.id.clone(),
        thread_id: None,
    });
    let provider = model_ref
        .split('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("openai");
    store
        .upsert(UpsertSessionBinding {
            session_id: session_id.to_owned(),
            role: existing
                .as_ref()
                .map(|binding| binding.role.clone())
                .unwrap_or(SessionRole::Butler),
            project_id: project_id.clone(),
            app_project_id: project_id
                .map(OwnOptional::Value)
                .unwrap_or(OwnOptional::Null),
            ledger_project_id: ledger_id
                .map(OwnOptional::Value)
                .unwrap_or(OwnOptional::Null),
            workspace_path: workspace,
            runtime_adapter_id: "btcc-turn-runtime".into(),
            model_provider_id: provider.into(),
            model_ref: model_ref.into(),
            runtime_session_ref: existing
                .as_ref()
                .and_then(|binding| binding.runtime_session_ref.clone()),
            provider_thread_ref: existing
                .as_ref()
                .and_then(|binding| binding.provider_thread_ref.clone()),
            transport_bindings,
            lifecycle_state: Some(SessionLifecycleState::Active),
            created_at: None,
            updated_at: None,
            last_active_at: None,
            metadata: Some(metadata),
        })
        .await
        .map_err(|_| {
            NativeIngressError::new("session_binding_unavailable", "Session binding unavailable")
        })
}
