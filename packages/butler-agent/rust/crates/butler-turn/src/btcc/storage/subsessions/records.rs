//! Persisted subsession records: the delegation packet
//! (`btcc_subsession_delegations.packet_json`), its dispatch intent and the
//! parent-input outbox rows. Field order is the persisted form.

use serde::{Deserialize, Serialize};
use serde_json::Value;
mod render;

/// The role of a child subsession.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildRole {
    Steward,
    Worker,
}

impl ChildRole {
    /// The persisted role name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steward => "steward",
            Self::Worker => "worker",
        }
    }
}

/// Whether a child may mutate the workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PacketExecutionMode {
    ReadOnly,
    Mutation,
}

impl PacketExecutionMode {
    /// The persisted mode name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::Mutation => "mutation",
        }
    }

    /// Read-only for a read-only access mode, else mutation.
    pub fn for_access(access_mode: &str) -> Self {
        if access_mode == "read_only" {
            Self::ReadOnly
        } else {
            Self::Mutation
        }
    }
}

/// The delegated task a child subsession executes. Steward packets carry the
/// parent chat; worker packets carry the source call, brief, plan action and
/// worker profile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SubsessionPacket {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<crate::btcc::TaskContract>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_overlaps: Vec<crate::btcc::TaskOverlap>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub task_context: String,
    pub child_role: ChildRole,
    pub delegation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tool_call_id: Option<String>,
    pub task_id: String,
    pub parent_session_id: String,
    pub parent_turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_chat_id: Option<String>,
    pub relation_id: String,
    pub access_mode: crate::btcc::AccessMode,
    pub execution_mode: PacketExecutionMode,
    pub objective: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    /// Runtime-attached previous request and canonical result for a fresh follow-up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior_context: Option<String>,
    pub acceptance_criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub implementation_brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_action: Option<PacketPlanAction>,
    pub task_or_plan_refs: Vec<String>,
    pub constraints_and_non_goals: Vec<String>,
    pub allowed_tools_and_effects: Vec<String>,
    pub mutation_scope: Vec<String>,
    /// Absent on packets written before the reviewed parent Work was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_work_ref: Option<ParentWorkRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_profile: Option<PacketWorkerProfile>,
    pub model_ref: String,
    pub reasoning_effort: String,
    /// The unattended schedule run this work belongs to (D8): its children
    /// and the results they report cannot wait for the user either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
}

/// The plan action a worker executes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PacketPlanAction {
    pub action_key: String,
    pub description: String,
    pub dependency_keys: Vec<String>,
}

/// The reviewed parent Work a delegation executes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParentWorkRef {
    pub work_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub plan_revision_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_revision_id: Option<String>,
}

/// The worker profile a worker runs with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PacketWorkerProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub id: String,
    /// Passthrough: the profile's configured job, opaque to BTCC.
    pub job: Value,
}

/// How a child is dispatched: its queue envelope and dispatch source.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DispatchIntent {
    pub envelope: ChildEnvelope,
    pub metadata: DispatchMetadata,
}

/// Where a dispatch came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchMetadata {
    pub source: String,
}

/// An App inbound envelope that starts a child (or parent) subsession turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildEnvelope {
    pub event_id: String,
    pub transport: String,
    pub account_id: String,
    pub peer: EnvelopePeer,
    pub sender: EnvelopeSender,
    pub message: EnvelopeMessage,
    pub routing_hints: EnvelopeRouting,
    pub native_steward_context: NativeStewardContext,
    pub raw: EnvelopeRaw,
}

/// The direct-message peer of an envelope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopePeer {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

/// The synthetic sender of an envelope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeSender {
    pub id: String,
    pub display_name: String,
}

/// The message an envelope delivers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeMessage {
    pub id: String,
    pub text: String,
    pub timestamp: String,
}

/// The session and turn an envelope routes to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeRouting {
    /// Named `stewardId` before envelopes could target workers.
    #[serde(alias = "stewardId")]
    pub session_id: String,
    pub turn_id: String,
}

/// The steward/worker context of the receiving session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStewardContext {
    pub version: u32,
    /// Absent on envelopes written when only stewards were dispatched.
    #[serde(default = "legacy_context_role")]
    pub role: String,
    pub project_name: String,
    pub workspace_path: String,
    pub model_ref: String,
    pub reasoning_effort: String,
    /// The unattended schedule run this work belongs to (D8): its children
    /// and the results they report cannot wait for the user either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
}

fn legacy_context_role() -> String {
    "steward".into()
}

/// The provenance of an envelope.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeRaw {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_relation_id: Option<String>,
}

/// A child result waiting in the parent-input outbox (`input_json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "route", rename_all = "snake_case")]
pub enum ParentResultInput {
    /// A worker result for its steward's queue.
    StewardQueue(WorkerResultInput),
    /// A steward result for the butler App (posted as this JSON).
    ButlerApp(Box<StewardResultInput>),
}

/// A worker result for the steward.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerResultInput {
    pub text: String,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub timestamp: String,
}

/// A steward result for the butler App.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StewardResultInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
    pub relation_id: String,
    pub result_id: String,
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub parent_chat_id: String,
    pub message_id: String,
    pub safe_title: String,
    pub text: String,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub access_mode: String,
    pub timestamp: String,
    /// The unattended schedule run this work belongs to (D8): its children
    /// and the results they report cannot wait for the user either.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
}

/// The route of an outbox row, read before the row is decoded.
#[derive(serde::Deserialize)]
pub(super) struct RouteTag {
    pub(super) route: Option<OutboxRoute>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum OutboxRoute {
    StewardQueue,
    ButlerApp,
    #[serde(other)]
    Unknown,
}

#[cfg(any(test, feature = "test-support"))]
impl SubsessionPacket {
    /// A minimal packet of `role` for fixtures.
    pub fn fixture(role: ChildRole, objective: &str) -> Self {
        Self {
            task: None,
            task_overlaps: Vec::new(),
            task_context: String::new(),
            child_role: role,
            delegation_id: "delegation".into(),
            source_tool_call_id: None,
            task_id: "task".into(),
            parent_session_id: "parent-session".into(),
            parent_turn_id: "parent-turn".into(),
            parent_chat_id: Some("parent-chat".into()),
            relation_id: "relation".into(),
            access_mode: crate::btcc::AccessMode::FullAccess,
            execution_mode: PacketExecutionMode::Mutation,
            objective: objective.into(),
            user_request: None,
            superseded_by: None,
            prior_context: None,
            acceptance_criteria: Vec::new(),
            implementation_brief: None,
            plan_action: None,
            task_or_plan_refs: Vec::new(),
            constraints_and_non_goals: Vec::new(),
            allowed_tools_and_effects: Vec::new(),
            mutation_scope: Vec::new(),
            parent_work_ref: Some(ParentWorkRef {
                work_id: "work".into(),
                session_id: "parent-session".into(),
                turn_id: "parent-turn".into(),
                plan_revision_id: "plan".into(),
                review_revision_id: Some("review".into()),
            }),
            worker_profile: None,
            model_ref: "provider/model".into(),
            reasoning_effort: "medium".into(),
            schedule_run: None,
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
impl DispatchIntent {
    /// A dispatch intent for fixtures.
    pub fn fixture() -> Self {
        Self {
            envelope: ChildEnvelope {
                event_id: "event".into(),
                transport: "app".into(),
                account_id: "local".into(),
                peer: EnvelopePeer {
                    kind: "dm".into(),
                    id: "child".into(),
                    parent_id: None,
                },
                sender: EnvelopeSender {
                    id: "sender".into(),
                    display_name: "Sender".into(),
                },
                message: EnvelopeMessage {
                    id: "message".into(),
                    text: "text".into(),
                    timestamp: "now".into(),
                },
                routing_hints: EnvelopeRouting {
                    session_id: "child".into(),
                    turn_id: "turn".into(),
                },
                native_steward_context: NativeStewardContext {
                    version: 1,
                    role: "steward".into(),
                    project_name: String::new(),
                    workspace_path: "/tmp".into(),
                    model_ref: "provider/model".into(),
                    reasoning_effort: "medium".into(),
                    schedule_run: None,
                },
                raw: EnvelopeRaw {
                    source: "fixture".into(),
                    result_id: None,
                    parent_relation_id: None,
                },
            },
            metadata: DispatchMetadata {
                source: "fixture".into(),
            },
        }
    }
}

#[cfg(test)]
mod tests;
