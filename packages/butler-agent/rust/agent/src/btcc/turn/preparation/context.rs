use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{ContextAssembly, ContextSection, js_truthy, object};
use crate::btcc::identity::digest;
use crate::btcc::storage::{BtccRepositories, ContextDocumentInput};
use crate::btcc::subsessions::SubsessionMetadata;
use crate::btcc::{AccessMode, BtccError, TurnRequest, VerifiedExecutionControls};
use crate::json::stringify;
use crate::public_text::trim_js_whitespace;
use crate::workspace::{SessionRole, StoredSessionBinding};

pub(super) async fn snapshot(
    repositories: &BtccRepositories,
    binding: &StoredSessionBinding,
    request: &TurnRequest,
    assembly: &ContextAssembly,
    subsession: Option<&SubsessionMetadata>,
    controls: Option<&VerifiedExecutionControls>,
) -> Result<Value, BtccError> {
    let user_ref = if subsession.is_some() {
        "steward-role".into()
    } else {
        principal_ref(binding)
    };
    let project_ref = subsession
        .and_then(|value| value.project_context.as_ref().map(|v| v.project_id.clone()))
        .or_else(|| binding.project_id.clone());
    let mut profile = Vec::new();
    let mut feedback = Vec::new();
    let mut mandatory = Vec::new();
    let mut optional = Vec::new();
    for section in sections(assembly) {
        let scope_id = match section.scope_kind.as_str() {
            "user" => user_ref.clone(),
            "session" => binding.session_id.clone(),
            "project" => project_ref.clone().ok_or_else(|| {
                BtccError::new(
                    "context_project_binding_missing",
                    "BTCC project context section requires a project binding",
                )
            })?,
            _ => {
                return Err(BtccError::new(
                    "context_scope_invalid",
                    "BTCC context scope is invalid",
                ));
            }
        };
        let reference = repositories
            .persist_context_document(ContextDocumentInput {
                scope_kind: section.scope_kind.clone(),
                scope_id,
                projection_class: section.projection_class.clone(),
                source_id: section.id.clone(),
                source_revision: section_revision(section)?,
                content: format!("## {}\n\n{}", section.title, section.content),
            })
            .await?;
        match section.projection_class.as_str() {
            "profile" => profile.push(reference),
            "recent_feedback" => feedback.push(reference),
            "mandatory_hot_cache" => mandatory.push(reference),
            "optional_hot_cache" => optional.push(reference),
            _ => {
                return Err(BtccError::new(
                    "context_projection_invalid",
                    "BTCC context projection is invalid",
                ));
            }
        }
    }
    let mut observations = vec![
        format!("workspace:{}", binding.workspace_path),
        "web:current".into(),
        format!("memory:{user_ref}"),
    ];
    if let Some(project) = &project_ref {
        observations.push(format!("ledger:{project}"));
    }
    if let Some(subsession) = subsession {
        feedback = unique(
            feedback
                .into_iter()
                .chain(subsession.recent_feedback_refs.clone()),
        );
        if let Some(project) = &subsession.project_context {
            mandatory = unique(
                mandatory
                    .into_iter()
                    .chain(project.mandatory_hot_cache_refs.clone()),
            );
            optional = unique(
                optional
                    .into_iter()
                    .chain(project.optional_hot_cache_refs.clone()),
            );
        }
        observations.clear();
    }
    let mut context = Map::new();
    context.insert("userRef".into(), user_ref.into());
    if let Some(project) = project_ref {
        context.insert("projectRef".into(), project.into());
    }
    context.insert("profileRefs".into(), strings(profile));
    context.insert("recentFeedbackRefs".into(), strings(feedback));
    context.insert("mandatoryHotCacheRefs".into(), strings(mandatory));
    context.insert("optionalHotCacheRefs".into(), strings(optional));
    context.insert("baselineObservationScopeRefs".into(), strings(observations));
    context.insert(
        "executionPolicy".into(),
        execution_policy(binding, subsession, controls)?,
    );
    if let Some(value) = authority_value(
        request,
        "authorityRequestRef",
        request.authority_request_ref.as_ref(),
    ) {
        context.insert("authorityRequestRef".into(), value.into());
    }
    if let Some(value) = authority_value(
        request,
        "authorityClientMessageId",
        request.authority_client_message_id.as_ref(),
    ) {
        context.insert("authorityClientMessageId".into(), value.into());
    }
    if let Some(plan) = metadata(binding)
        .get("plan_id")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|v| !v.is_empty())
    {
        context.insert("planId".into(), plan.into());
    }
    if !request.message.attachments.is_empty() {
        context.insert(
            "attachments".into(),
            Value::Array(
                request
                    .message
                    .attachments
                    .iter()
                    .map(|value| {
                        let mut item = Map::new();
                        item.insert("id".into(), value.id.clone().into());
                        item.insert(
                            "kind".into(),
                            serde_json::to_value(&value.kind).expect("attachment kind"),
                        );
                        if let Some(v) = value.mime_type.as_ref().filter(|v| !v.is_empty()) {
                            item.insert("mimeType".into(), v.clone().into());
                        }
                        if let Some(v) = value.file_name.as_ref().filter(|v| !v.is_empty()) {
                            item.insert("fileName".into(), v.clone().into());
                        }
                        if let Some(v) = value.size_bytes.filter(|v| v.is_finite())
                            && let Some(number) = serde_json::Number::from_f64(v)
                        {
                            item.insert("sizeBytes".into(), Value::Number(number));
                        }
                        if let Some(v) = value.url.as_ref().filter(|v| !v.is_empty()) {
                            item.insert("url".into(), v.clone().into());
                        }
                        if !matches!(value.kind, crate::btcc::AttachmentKind::Image)
                            && let Some(v) = value.local_path.as_ref().filter(|v| !v.is_empty())
                        {
                            item.insert("localPath".into(), v.clone().into());
                        }
                        if let Some(v) = value.visual_manifest.as_ref().filter(|v| js_truthy(v)) {
                            item.insert("visualManifest".into(), v.clone());
                        }
                        Value::Object(item)
                    })
                    .collect(),
            ),
        );
    }
    if let Some(value) = &request.message.image_admission {
        context.insert("imageAdmission".into(), value.clone());
    }
    Ok(Value::Object(context))
}

fn execution_policy(
    binding: &StoredSessionBinding,
    subsession: Option<&SubsessionMetadata>,
    controls: Option<&VerifiedExecutionControls>,
) -> Result<Value, BtccError> {
    let metadata = metadata(binding);
    let runtime = object(metadata.get("runtimePolicy"));
    let mut policy = Map::new();
    policy.insert("role".into(), role(binding).into());
    policy.insert(
        "accessMode".into(),
        serde_json::to_value(
            controls
                .map(|v| &v.access_mode)
                .unwrap_or_else(|| binding_access_mode(binding)),
        )
        .map_err(json_error)?,
    );
    policy.insert("trackingMode".into(), tracking_mode(binding).into());
    policy.insert(
        "requiredNativeToolProfiles".into(),
        strings(unique(
            string_array(metadata.get("requiredNativeToolProfiles"))
                .into_iter()
                .chain(string_array(runtime.get("requiredNativeToolProfiles"))),
        )),
    );
    let required = unique(
        string_array(metadata.get("requiredNativeTools"))
            .into_iter()
            .chain(string_array(metadata.get("required_tools")))
            .chain(string_array(runtime.get("requiredNativeTools")))
            .chain(string_array(runtime.get("required_tools"))),
    );
    policy.insert("requiredNativeTools".into(), strings(required));
    policy.insert(
        "workspacePath".into(),
        binding.workspace_path.clone().into(),
    );
    if let Some(value) = subsession {
        policy.insert("subsession".into(), subsession_json(value));
    }
    if let Some(value) = &binding.project_id {
        policy.insert("projectId".into(), value.clone().into());
    }
    Ok(Value::Object(policy))
}

fn subsession_json(value: &SubsessionMetadata) -> Value {
    let mut out = Map::new();
    out.insert("relationId".into(), value.relation_id.clone().into());
    out.insert("delegationId".into(), value.delegation_id.clone().into());
    out.insert("taskId".into(), value.task_id.clone().into());
    out.insert(
        "executionMode".into(),
        match value.execution_mode {
            crate::btcc::subsessions::SubsessionExecutionMode::ReadOnly => "read_only",
            crate::btcc::subsessions::SubsessionExecutionMode::Mutation => "mutation",
        }
        .into(),
    );
    out.insert(
        "mutationScope".into(),
        strings(value.mutation_scope.clone()),
    );
    out.insert(
        "allowedToolsAndEffects".into(),
        strings(value.allowed_tools_and_effects.clone()),
    );
    out.insert(
        "recentFeedbackRefs".into(),
        strings(value.recent_feedback_refs.clone()),
    );
    if let Some(project) = &value.project_context {
        out.insert(
            "projectContext".into(),
            Value::Object(Map::from_iter([
                ("projectId".into(), project.project_id.clone().into()),
                (
                    "mandatoryHotCacheRefs".into(),
                    strings(project.mandatory_hot_cache_refs.clone()),
                ),
                (
                    "optionalHotCacheRefs".into(),
                    strings(project.optional_hot_cache_refs.clone()),
                ),
            ])),
        );
    }
    Value::Object(out)
}

fn section_revision(section: &ContextSection) -> Result<String, BtccError> {
    let body = Value::Object(Map::from_iter([
        ("id".into(), section.id.clone().into()),
        ("content".into(), section.content.clone().into()),
        (
            "projectionClass".into(),
            section.projection_class.clone().into(),
        ),
        ("scopeKind".into(), section.scope_kind.clone().into()),
    ]));
    Ok(digest(&stringify(&body).map_err(json_error)?))
}
fn sections(assembly: &ContextAssembly) -> impl Iterator<Item = &ContextSection> {
    assembly
        .static_context
        .iter()
        .chain(&assembly.live_configuration)
        .chain(&assembly.runtime_state)
        .chain(&assembly.working_context)
        .chain(&assembly.retrieved_context)
}
fn principal_ref(binding: &StoredSessionBinding) -> String {
    metadata(binding)
        .get("userRef")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|v| !v.is_empty())
        .unwrap_or("local-principal")
        .into()
}
fn metadata(binding: &StoredSessionBinding) -> &Map<String, Value> {
    match binding.metadata.as_ref() {
        Some(value) => value,
        None => super::empty_object(),
    }
}
fn role(binding: &StoredSessionBinding) -> &str {
    match &binding.role {
        SessionRole::Butler => "butler",
        SessionRole::Steward => "steward",
        SessionRole::Worker => "worker",
        SessionRole::Unknown(v) => v,
    }
}
fn binding_access_mode(binding: &StoredSessionBinding) -> &AccessMode {
    static READ_ONLY: AccessMode = AccessMode::ReadOnly;
    static FULL: AccessMode = AccessMode::FullAccess;
    static ASK: AccessMode = AccessMode::AskFirst;
    let metadata = metadata(binding);
    let runtime = object(metadata.get("runtimePolicy"));
    match runtime
        .get("accessMode")
        .filter(|value| !value.is_null())
        .or_else(|| metadata.get("accessMode"))
        .and_then(Value::as_str)
    {
        Some("full_access") => &FULL,
        Some("ask_first") => &ASK,
        _ => &READ_ONLY,
    }
}
fn tracking_mode(binding: &StoredSessionBinding) -> &'static str {
    let runtime = object(metadata(binding).get("runtimePolicy"));
    match runtime
        .get("trackingMode")
        .filter(|value| !value.is_null())
        .or_else(|| runtime.get("tracking_mode"))
        .and_then(Value::as_str)
    {
        Some("ledger") => "ledger",
        Some("local") => "local",
        Some("none") => "none",
        _ if binding.project_id.is_some() => "ledger",
        _ => "local",
    }
}
fn authority_value<'a>(
    request: &'a TurnRequest,
    key: &str,
    fallback: Option<&'a String>,
) -> Option<&'a str> {
    let app = request
        .app_turn_context
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|v| v.get(key));
    match app {
        Some(Value::Null) | None => fallback.map(String::as_str).filter(|v| !v.is_empty()),
        Some(Value::String(v)) if !v.is_empty() => Some(v),
        _ => None,
    }
}
fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}
fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|v| seen.insert(v.clone()))
        .collect()
}
fn strings(values: Vec<String>) -> Value {
    Value::Array(values.into_iter().map(Value::String).collect())
}
fn json_error(error: impl std::fmt::Display) -> BtccError {
    BtccError::new("btcc_json_error", error.to_string())
}
