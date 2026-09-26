//! Deterministic subsession packets and host envelopes.

use super::*;

pub(super) fn render_input(packet: &Value, profile_prompt: Option<&str>) -> String {
    let base = format!(
        "role: worker\nassigned_objective: {}\nacceptance_criteria: {}\nimplementation_brief: {}\nReport the bounded result to the Steward.",
        packet["objective"].as_str().unwrap_or(""),
        packet["acceptance_criteria"],
        packet["implementation_brief"].as_str().unwrap_or("")
    );
    match profile_prompt.filter(|value| !value.trim().is_empty()) {
        Some(prompt) => format!("{base}\nworker_profile_prompt: {prompt}"),
        None => base,
    }
}
pub(super) fn render_steward_input(packet: &Value) -> String {
    format!(
        "role: steward\nrequest: {}\nacceptance_criteria: {}\nPlan, execute, review, and report this delegated request to Butler.",
        packet["objective"].as_str().unwrap_or(""),
        packet["acceptance_criteria"]
    )
}
pub(super) fn allowed_effects(access: &str) -> Vec<&'static str> {
    if access == "read_only" {
        vec![
            "grep_files:workspace",
            "list_files:workspace",
            "read_file:workspace",
            "web_read:network",
            "web_search:network",
        ]
    } else {
        vec![
            "edit_file:workspace",
            "run_command:workspace",
            "write_file:workspace",
        ]
    }
}
pub(super) fn mutation_scope(access: &str) -> Vec<String> {
    if access == "read_only" {
        Vec::new()
    } else {
        vec![".".to_owned()]
    }
}
pub(super) fn child_metadata(
    role: &str,
    packet: &Value,
    access: &str,
    parent: &crate::workspace::StoredSessionBinding,
) -> Value {
    let mut runtime_policy = if role == "steward" {
        parent
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("runtimePolicy"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    } else {
        Map::new()
    };
    let tracking_mode = if role == "worker" {
        "local"
    } else {
        runtime_policy
            .get("trackingMode")
            .filter(|value| !value.is_null())
            .or_else(|| runtime_policy.get("tracking_mode"))
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "ledger" | "local" | "none"))
            .unwrap_or(
                if parent
                    .project_id
                    .as_deref()
                    .is_some_and(|id| !id.trim().is_empty())
                {
                    "ledger"
                } else {
                    "local"
                },
            )
    }
    .to_owned();
    let profiles = if role == "worker" {
        if access == "full_access" {
            json!(["workspace"])
        } else {
            json!([])
        }
    } else {
        string_values(runtime_policy.get("requiredNativeToolProfiles"))
    };
    let tools = if role == "worker" {
        json!([])
    } else {
        string_values(
            runtime_policy
                .get("requiredNativeTools")
                .filter(|value| !value.is_null())
                .or_else(|| runtime_policy.get("required_tools")),
        )
    };
    runtime_policy.insert("accessMode".into(), Value::String(access.into()));
    runtime_policy.insert("trackingMode".into(), Value::String(tracking_mode.clone()));
    runtime_policy.insert("tracking_mode".into(), Value::String(tracking_mode));
    runtime_policy.insert("requiredNativeToolProfiles".into(), profiles);
    runtime_policy.insert("requiredNativeTools".into(), json!(tools.clone()));
    runtime_policy.insert("required_tools".into(), json!(tools));
    runtime_policy.insert(
        "authoritySource".into(),
        Value::String("parent_session".into()),
    );
    runtime_policy.insert(
        "authority_source".into(),
        Value::String("parent_session".into()),
    );

    json!({"source":if role=="worker"{"btcc-worker"}else{"btcc-subsession"},"reasoning_effort":packet["reasoning_effort"],"subsession":{"relation_id":packet["relation_id"],"delegation_id":packet["delegation_id"],"task_id":packet["task_id"],"parent_session_id":packet["parent_session_id"],"execution_mode":packet["execution_mode"],"mutation_scope":packet["mutation_scope"],"allowed_tools_and_effects":packet["allowed_tools_and_effects"]},"runtimePolicy":runtime_policy})
}

pub(super) fn child_work_scope(
    stored: &crate::btcc::StoredSubsessionDelegation,
    binding: &crate::workspace::StoredSessionBinding,
    turn_id: &str,
) -> Result<WorkTurnScope, BtccError> {
    if binding.session_id != stored.child_session_id {
        return Err(error("subsession_child_binding_mismatch"));
    }
    let role = stored.packet["child_role"].as_str();
    let expected_role = match role {
        Some("steward") => crate::workspace::SessionRole::Steward,
        Some("worker") => crate::workspace::SessionRole::Worker,
        _ => return Err(error("subsession_child_role_invalid")),
    };
    if binding.role != expected_role {
        return Err(error("subsession_child_binding_mismatch"));
    }
    let project_ref = if role == Some("steward") {
        let policy = binding
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("runtimePolicy"));
        let tracking_mode = policy
            .and_then(Value::as_object)
            .and_then(|policy| {
                policy
                    .get("trackingMode")
                    .filter(|value| !value.is_null())
                    .or_else(|| policy.get("tracking_mode"))
            })
            .and_then(Value::as_str)
            .filter(|value| matches!(*value, "ledger" | "local" | "none"))
            .unwrap_or(
                if binding
                    .project_id
                    .as_deref()
                    .is_some_and(|id| !id.trim().is_empty())
                {
                    "ledger"
                } else {
                    "local"
                },
            );
        match tracking_mode {
            "ledger" => {
                if binding
                    .ledger_project_id
                    .as_deref()
                    .is_none_or(|id| id.trim().is_empty())
                {
                    return Err(error("steward_project_binding_missing"));
                }
                Some(
                    binding
                        .app_project_id
                        .as_deref()
                        .or(binding.project_id.as_deref())
                        .filter(|id| !id.trim().is_empty())
                        .ok_or_else(|| error("steward_project_binding_missing"))?
                        .to_owned(),
                )
            }
            _ => None,
        }
    } else {
        // Worker delegation deliberately keeps a session-owned Work even when
        // its inherited binding carries Project identity.
        None
    };
    Ok(WorkTurnScope {
        turn_id: turn_id.to_owned(),
        session_id: binding.session_id.clone(),
        project_ref,
    })
}

pub(super) fn work_matches_scope(work: &crate::btcc::WorkView, scope: &WorkTurnScope) -> bool {
    if work.session_id != scope.session_id {
        return false;
    }
    match (&work.scope, scope.project_ref.as_deref()) {
        (crate::btcc::WorkScope::Session { session_id }, None) => session_id == &scope.session_id,
        (crate::btcc::WorkScope::Project { project_ref }, Some(expected)) => {
            project_ref == expected
        }
        _ => false,
    }
}

fn string_values(value: Option<&Value>) -> Value {
    let mut values = Vec::new();
    if let Some(items) = value.and_then(Value::as_array) {
        for item in items {
            if let Some(text) = item.as_str().map(str::trim).filter(|text| !text.is_empty())
                && !values.iter().any(|value| value == text)
            {
                values.push(text.to_owned());
            }
        }
    }
    json!(values)
}
pub(super) struct ChildEnvelopeInput<'a> {
    pub role: &'a str,
    pub delegation: &'a str,
    pub child: &'a str,
    pub parent_id: &'a str,
    pub turn: &'a str,
    pub parent: &'a crate::workspace::StoredSessionBinding,
    pub model: &'a str,
    pub reasoning: &'a str,
    pub text: String,
    pub now: &'a str,
}

pub(super) fn child_envelope(input: ChildEnvelopeInput<'_>) -> Value {
    let ChildEnvelopeInput {
        role,
        delegation,
        child,
        parent_id,
        turn,
        parent,
        model,
        reasoning,
        text,
        now,
    } = input;
    json!({"eventId":format!("{role}:{delegation}"),"transport":"app","accountId":"local","peer":{"kind":"dm","id":child,"parentId":parent_id},"sender":{"id":format!("butler-{role}-dispatch"),"displayName":if role=="worker"{"Butler Worker"}else{"Butler Steward"}},"message":{"id":format!("{role}-message:{delegation}"),"text":text,"timestamp":now},"routingHints":{"sessionId":child,"turnId":turn},"nativeStewardContext":{"version":1,"role":role,"projectName":parent.project_id.clone().unwrap_or_default(),"workspacePath":parent.workspace_path,"modelRef":model,"reasoningEffort":reasoning},"raw":{"source":if role=="worker"{"btcc-worker-delegation"}else{"btcc-subsession-delegation"}}})
}
pub(super) fn delegation_output(stored: &crate::btcc::StoredSubsessionDelegation) -> Value {
    json!({"ok":true,"status":"queued","relation_id":stored.relation_id,"child_session_id":stored.child_session_id})
}
pub(super) fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
pub(super) fn storage(e: crate::btcc::StorageError) -> BtccError {
    BtccError::new(e.code, e.message)
}
pub(super) fn workspace(e: crate::workspace::WorkspaceError) -> BtccError {
    BtccError::new(e.code, e.message)
}
