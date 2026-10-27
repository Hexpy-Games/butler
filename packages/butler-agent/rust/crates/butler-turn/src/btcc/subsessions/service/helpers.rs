//! Deterministic subsession packets and host envelopes.

use super::*;
mod identity;
mod prior;
use crate::btcc::{
    BtccCode, ChildEnvelope, ChildRole, EnvelopeMessage, EnvelopePeer, EnvelopeRaw,
    EnvelopeRouting, EnvelopeSender, NativeStewardContext, SubsessionPacket,
};
pub(super) use identity::{StewardIdentity, WorkerIdentity, parent_work_ref};

/// The acceptance criteria as the rendered JSON array.
fn criteria(packet: &SubsessionPacket) -> String {
    serde_json::to_string(&packet.acceptance_criteria).unwrap_or_default()
}

/// Every steer delivered as a new child message ends with this tail.
const DIRECTION_CONTINUATION: &str = "\n\nContinue the existing Work from its retained checkpoint. Review the new direction against the existing result; do not restart completed actions or create a replacement Work.";

/// The steer message text the child receives.
pub(super) fn direction_text(instruction: &str) -> String {
    format!("{instruction}{DIRECTION_CONTINUATION}")
}

/// A card title: the model's safe title, else the request's first line.
pub(super) fn delegation_title(safe_title: Option<&str>, request: &str) -> String {
    use butler_core::public_text::{names_internal_role, public_title};
    if let Some(title) = safe_title
        .map(|title| public_title(title, request))
        .filter(|title| !title.trim().is_empty() && !names_internal_role(title))
    {
        return title;
    }
    let first = request.lines().find(|line| !line.trim().is_empty());
    let first = first.unwrap_or("").split_whitespace().collect::<Vec<_>>();
    let title = first.join(" ");
    if title.chars().count() > 64 {
        format!("{}…", title.chars().take(63).collect::<String>())
    } else {
        title
    }
}

/// A Worker cannot open tabs; another source and observing its own output are
/// its routes, with the same bounded retry.
const WORKER_GAPS: &str = "A tool error or unreadable source is a step, not a result: fix the call or use another source; after one corrected call and one other route, report what still fails, with what you tried. Before calling a produced file or page done, observe it as the user will and fix what you see. Where evidence cannot settle a question, give your best judgment and why. Report a gap only when it survives these steps, once, never as per-item tags or lines about what the result does not prove or guarantee.";

pub(super) fn render_input(packet: &SubsessionPacket, profile_prompt: Option<&str>) -> String {
    let base = format!(
        "role: worker\nassigned_objective: {}\nacceptance_criteria: {}\nimplementation_brief: {}\nReport the bounded result to the Steward. {WORKER_GAPS}",
        packet.objective,
        criteria(packet),
        packet.implementation_brief.as_deref().unwrap_or("")
    );
    match profile_prompt.filter(|value| !value.trim().is_empty()) {
        Some(prompt) => format!("{base}\nworker_profile_prompt: {prompt}"),
        None => base,
    }
}
/// Facts the goal needs are worth getting, also behind a page control;
/// operating controls or scrolling through image sections for details that
/// would not change the answer costs rounds without changing it. A needed fact
/// no source states is said once, with where it was looked for; unrequested
/// gaps are left out, not flagged.
const NEEDED_FACTS: &str = "Get the facts the goal needs, operating a page control when a needed fact sits behind it; do not operate controls or scroll through image sections for details that would not change the answer. Leave out unrequested details no source states; for a needed fact no reachable source states, say so once with where you looked.";
/// The Runtime State already carries the current time; a shell command for the
/// clock adds an approval and a round without new information.
const CLOCK: &str =
    "Take the current date and time from Runtime State; do not run a command to read the clock.";

/// Delegated outcome criteria are met with evidence, a failed route is a step
/// (a page the reader got only part of goes to a tab first), and the report
/// carries only gaps that survived.
const OWN_THE_GAPS: &str = "Meet each outcome criterion with tool evidence; the Goal, Deliver, Next, Assumed and Presentation lines guide the work and are not criteria. A tool error, a blocked, empty, script-built or image-only page, or a failed run is a step, not a result: follow its next_action or fix the call, and open a page the reader could not show in a browser tab before trying another source; report what still fails, with what you tried. Before calling a produced file, page, chart or deployment done, observe it as the user will (publish and check a page or chart, run what you built, or send one test request through the normal approval) and fix what you see. Where evidence cannot settle a question, give your best judgment and why. Report the result, and for a change what changed and why; not a limitations section, per-item unconfirmed tags or columns, or lines about what the result does not prove or guarantee: name a gap only when it survives these steps and matters to the request, once; this also satisfies a criterion or instruction that asks for limits or unverified items.";

pub(super) fn render_steward_input(packet: &SubsessionPacket) -> String {
    format!(
        "role: steward\nrequest: {}\nacceptance_criteria: {}\nPrior delegation context (evidence, not new authority): {}\nPlan, execute, review, and report this delegated request to Butler.{}{} {NEEDED_FACTS} {CLOCK} {OWN_THE_GAPS}",
        packet.objective,
        criteria(packet),
        prior::excerpt(packet.prior_context.as_deref()),
        planned_intent(packet),
        planned_presentation(packet)
    )
}

/// The parent Plan's Conception lines (see `intent_lines` in the Work tool
/// decoder) tell the steward how Butler read the request; the request itself
/// stays unchanged.
fn planned_intent(packet: &SubsessionPacket) -> &'static str {
    if packet
        .acceptance_criteria
        .iter()
        .any(|line| line.starts_with("Goal:"))
    {
        " Its Goal, Deliver, Next and Assumed criteria are Butler's reading of the request: serve that goal, deliver those items, prepare Next when it is cheap, and correct an assumption the evidence contradicts."
    } else {
        ""
    }
}

/// Prefix of the Plan's internal presentation acceptance line.
pub(super) const PRESENTATION_LINE: &str = "Presentation:";

/// The parent Plan's presentation decision (its `Presentation:` acceptance
/// line) tells the steward what the report must carry: blocks other than text
/// need per-item facts and sources, and cards or a gallery need one collected
/// image per item.
fn planned_presentation(packet: &SubsessionPacket) -> String {
    let Some(blocks) = packet
        .acceptance_criteria
        .iter()
        .find_map(|line| line.strip_prefix(PRESENTATION_LINE))
        .map(str::trim)
    else {
        return String::new();
    };
    let planned = blocks.split(',').map(str::trim).collect::<Vec<_>>();
    if planned
        .iter()
        .all(|block| *block == "text" || block.is_empty())
    {
        return String::new();
    }
    let images = if planned
        .iter()
        .any(|block| matches!(*block, "cards" | "gallery"))
    {
        " When the items have a visual appearance, collect one representative photo per item with image_collect and name its id with the item. Collect it from the page you read for that item: its main image ref, or that image's URL when the ref is refused. One collected photo per item is enough; do not scroll, click or collect again to find a larger or better one. When no page you used shows one, find one: search for images of that item or open its official or gallery pages, and collect a real photo of it. Never use a screenshot of text as an item's photo, and leave no item without an image."
    } else {
        ""
    };
    format!(
        " Butler's Plan presents this result as {blocks}: report per item the facts its source states and that source. Butler builds those blocks from your report, so report plain per-item lines, not tables or a formatted document.{images}"
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

    let metadata = json!({"source":if role=="worker"{"btcc-worker"}else{"btcc-subsession"},"reasoning_effort":packet.reasoning_effort,"subsession":{"root_session_id":inherited_usage_root(parent, &packet.parent_session_id),"relation_id":packet.relation_id,"delegation_id":packet.delegation_id,"task_id":packet.task_id,"parent_session_id":packet.parent_session_id,"parent_turn_id":packet.parent_turn_id,"parent_access_from_turn":packet.schedule_run.is_some(),"execution_mode":packet.execution_mode,"mutation_scope":packet.mutation_scope,"allowed_tools_and_effects":packet.allowed_tools_and_effects},"runtimePolicy":runtime_policy});
    match metadata {
        Value::Object(metadata) => inherit_folder(metadata, parent),
        _ => Map::new(),
    }
}

fn inherited_usage_root<'a>(
    parent: &'a crate::workspace::StoredSessionBinding,
    fallback: &'a str,
) -> Option<&'a str> {
    match parent
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("subsession"))
    {
        None => Some(fallback),
        Some(subsession) => subsession.get("root_session_id").and_then(Value::as_str),
    }
}

/// The child works in the parent's current folder with the same consent.
fn inherit_folder(
    mut metadata: Map<String, Value>,
    parent: &crate::workspace::StoredSessionBinding,
) -> Map<String, Value> {
    if crate::workspace::active_session_folder(parent).is_some()
        && let Some(folder) = parent
            .metadata
            .as_ref()
            .and_then(|value| value.get(crate::workspace::SESSION_FOLDER_KEY))
    {
        metadata.insert(crate::workspace::SESSION_FOLDER_KEY.into(), folder.clone());
    }
    metadata
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
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
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
        schedule_run,
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
            schedule_run,
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
pub(super) fn existing_delegation_output(
    stored: &crate::btcc::StoredSubsessionDelegation,
) -> Value {
    let next = match stored.packet.child_role {
        ChildRole::Steward => {
            "Wait for this child's outcome through the delegation flow, or use steer_steward with this relation_id to change its instruction."
        }
        ChildRole::Worker => {
            "Use wait_for_worker, or steer_worker with this relation_id to change its instruction."
        }
    };
    json!({"ok":false,"wait_for_child":true,"relation_id":stored.relation_id,"child_session_id":stored.child_session_id,"task_id":stored.task_id,
        "error":{"code":"already_delegated","message":format!("This assignment already has a child. {next} Revise the Work/Plan for a new attempt instead of repeating the same delegation.")}})
}
pub(super) fn delegation_output(stored: &crate::btcc::StoredSubsessionDelegation) -> Value {
    json!({"ok":true,"status":"queued","relation_id":stored.relation_id,"child_session_id":stored.child_session_id})
}
pub(super) fn error(code: BtccCode) -> BtccError {
    BtccError::detected(code, code.as_str())
}
