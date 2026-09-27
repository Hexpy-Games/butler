//! Deterministic subsession packets and host envelopes.

use super::*;
use crate::btcc::{
    BtccCode, ChildEnvelope, ChildRole, EnvelopeMessage, EnvelopePeer, EnvelopeRaw,
    EnvelopeRouting, EnvelopeSender, NativeStewardContext, SubsessionPacket,
};

/// The acceptance criteria as the rendered JSON array.
fn criteria(packet: &SubsessionPacket) -> String {
    serde_json::to_string(&packet.acceptance_criteria).unwrap_or_default()
}

pub(super) fn render_input(packet: &SubsessionPacket, profile_prompt: Option<&str>) -> String {
    let base = format!(
        "role: worker\nassigned_objective: {}\nacceptance_criteria: {}\nimplementation_brief: {}\nReport the bounded result to the Steward.",
        packet.objective,
        criteria(packet),
        packet.implementation_brief.as_deref().unwrap_or("")
    );
    match profile_prompt.filter(|value| !value.trim().is_empty()) {
        Some(prompt) => format!("{base}\nworker_profile_prompt: {prompt}"),
        None => base,
    }
}
pub(super) fn render_steward_input(packet: &SubsessionPacket) -> String {
    format!(
        "role: steward\nrequest: {}\nacceptance_criteria: {}\nPlan, execute, review, and report this delegated request to Butler.",
        packet.objective,
        criteria(packet)
    )
}
pub(super) fn allowed_effects(access: &str) -> Vec<String> {
    if access == "read_only" {
        [
            "grep_files:workspace",
            "list_files:workspace",
            "read_file:workspace",
            "web_read:network",
            "web_search:network",
        ]
        .map(String::from)
        .to_vec()
    } else {
        [
            "edit_file:workspace",
            "run_command:workspace",
            "write_file:workspace",
        ]
        .map(String::from)
        .to_vec()
    }
}
pub(super) fn mutation_scope(access: &str) -> Vec<String> {
    if access == "read_only" {
        Vec::new()
    } else {
        vec![".".to_owned()]
    }
}
/// The child's session-binding metadata (passthrough: binding metadata is a
/// free-form map shared with the App runtime policy).
pub(super) fn child_metadata(
    role: ChildRole,
    packet: &SubsessionPacket,
    access: &str,
    parent: &crate::workspace::StoredSessionBinding,
) -> Map<String, Value> {
    let role = role.as_str();
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

    let metadata = json!({"source":if role=="worker"{"btcc-worker"}else{"btcc-subsession"},"reasoning_effort":packet.reasoning_effort,"subsession":{"relation_id":packet.relation_id,"delegation_id":packet.delegation_id,"task_id":packet.task_id,"parent_session_id":packet.parent_session_id,"execution_mode":packet.execution_mode,"mutation_scope":packet.mutation_scope,"allowed_tools_and_effects":packet.allowed_tools_and_effects},"runtimePolicy":runtime_policy});
    match metadata {
        Value::Object(metadata) => metadata,
        _ => Map::new(),
    }
}

pub(super) fn child_work_scope(
    stored: &crate::btcc::StoredSubsessionDelegation,
    binding: &crate::workspace::StoredSessionBinding,
    turn_id: &str,
) -> Result<WorkTurnScope, BtccError> {
    if binding.session_id != stored.child_session_id {
        return Err(error(BtccCode::SubsessionChildBindingMismatch));
    }
    let role = stored.packet.child_role;
    let expected_role = match role {
        ChildRole::Steward => crate::workspace::SessionRole::Steward,
        ChildRole::Worker => crate::workspace::SessionRole::Worker,
    };
    if binding.role != expected_role {
        return Err(error(BtccCode::SubsessionChildBindingMismatch));
    }
    let project_ref = if role == ChildRole::Steward {
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
                    return Err(error(BtccCode::StewardProjectBindingMissing));
                }
                Some(
                    binding
                        .app_project_id
                        .as_deref()
                        .or(binding.project_id.as_deref())
                        .filter(|id| !id.trim().is_empty())
                        .ok_or_else(|| error(BtccCode::StewardProjectBindingMissing))?
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

// Passthrough: free-form session-binding metadata shared with the App runtime policy.
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

pub(super) fn child_envelope(input: ChildEnvelopeInput<'_>) -> ChildEnvelope {
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
    let worker = role == "worker";
    ChildEnvelope {
        event_id: format!("{role}:{delegation}"),
        transport: "app".into(),
        account_id: "local".into(),
        peer: EnvelopePeer {
            kind: "dm".into(),
            id: child.into(),
            parent_id: Some(parent_id.into()),
        },
        sender: EnvelopeSender {
            id: format!("butler-{role}-dispatch"),
            display_name: if worker {
                "Butler Worker"
            } else {
                "Butler Steward"
            }
            .into(),
        },
        message: EnvelopeMessage {
            id: format!("{role}-message:{delegation}"),
            text,
            timestamp: now.into(),
        },
        routing_hints: EnvelopeRouting {
            session_id: child.into(),
            turn_id: turn.into(),
        },
        native_steward_context: NativeStewardContext {
            version: 1,
            role: role.into(),
            project_name: parent.project_id.clone().unwrap_or_default(),
            workspace_path: parent.workspace_path.clone(),
            model_ref: model.into(),
            reasoning_effort: reasoning.into(),
        },
        raw: EnvelopeRaw {
            source: if worker {
                "btcc-worker-delegation"
            } else {
                "btcc-subsession-delegation"
            }
            .into(),
            result_id: None,
            parent_relation_id: None,
        },
    }
}
pub(super) fn delegation_output(stored: &crate::btcc::StoredSubsessionDelegation) -> Value {
    json!({"ok":true,"status":"queued","relation_id":stored.relation_id,"child_session_id":stored.child_session_id})
}
pub(super) fn error(code: BtccCode) -> BtccError {
    BtccError::detected(code, code.as_str())
}

/// The request identity a steward delegation id is derived from (persisted
/// through the id, so its field order is part of the format).
#[derive(serde::Serialize)]
pub(super) struct StewardIdentity<'a> {
    pub(super) parent_session_id: &'a str,
    pub(super) parent_turn_id: &'a str,
    pub(super) request: &'a str,
    pub(super) work_id: &'a str,
    pub(super) plan_revision_id: &'a str,
    pub(super) review_revision_id: &'a str,
}

/// The request identity a worker delegation id is derived from.
#[derive(serde::Serialize)]
pub(super) struct WorkerIdentity<'a> {
    pub(super) parent_session_id: &'a str,
    pub(super) parent_turn_id: &'a str,
    pub(super) action_key: &'a str,
    pub(super) objective: &'a str,
    pub(super) acceptance_criteria: &'a [String],
    pub(super) implementation_brief: &'a str,
    pub(super) profile_id: &'a str,
}

/// The reviewed parent Work a delegation executes.
pub(super) fn parent_work_ref(
    reviewed: &WorkView,
    parent_turn_id: &str,
    plan: &crate::btcc::WorkPlan,
    review: &crate::btcc::WorkReview,
) -> crate::btcc::ParentWorkRef {
    crate::btcc::ParentWorkRef {
        work_id: reviewed.work_id.clone(),
        session_id: reviewed.session_id.clone(),
        turn_id: parent_turn_id.into(),
        plan_revision_id: plan.plan_revision_id.clone(),
        review_revision_id: review.review_revision_id.clone(),
    }
}
