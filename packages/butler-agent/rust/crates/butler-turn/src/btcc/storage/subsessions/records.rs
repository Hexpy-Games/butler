//! Persisted subsession records: the delegation packet
//! (`btcc_subsession_delegations.packet_json`), its dispatch intent and the
//! parent-input outbox rows. Field order is the persisted form.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub access_mode: String,
    pub execution_mode: PacketExecutionMode,
    pub objective: String,
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
    pub review_revision_id: String,
}

/// The worker profile a worker runs with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PacketWorkerProfile {
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
    ButlerApp(StewardResultInput),
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
            child_role: role,
            delegation_id: "delegation".into(),
            source_tool_call_id: None,
            task_id: "task".into(),
            parent_session_id: "parent-session".into(),
            parent_turn_id: "parent-turn".into(),
            parent_chat_id: Some("parent-chat".into()),
            relation_id: "relation".into(),
            access_mode: "full_access".into(),
            execution_mode: PacketExecutionMode::Mutation,
            objective: objective.into(),
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
                review_revision_id: "review".into(),
            }),
            worker_profile: None,
            model_ref: "provider/model".into(),
            reasoning_effort: "medium".into(),
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

/// KEEP: pins of the persisted packet, dispatch intent and outbox forms
/// (field order as the pre-typed `json!` literals wrote them).
#[cfg(test)]
mod tests {
    use super::*;

    fn steward() -> SubsessionPacket {
        let mut packet = SubsessionPacket::fixture(ChildRole::Steward, "Do it");
        packet.acceptance_criteria = vec!["check".into()];
        packet.task_or_plan_refs = vec!["plan".into()];
        packet.allowed_tools_and_effects = vec!["edit_file:workspace".into()];
        packet.mutation_scope = vec![".".into()];
        packet
    }

    /// Format pin: persisted BTCC records and receipts stay byte-stable across
    /// versions: subsession packets, dispatch intents and outbox inputs,
    /// delegation identities, stored authority continuations, write and edit
    /// effect inputs and receipts, and transition payloads with changed files.
    // test-category: format-pin
    #[tokio::test]
    async fn persisted_btcc_records_are_byte_stable() {
        steward_packet_is_byte_stable();
        worker_packet_is_byte_stable();
        dispatch_intent_is_byte_stable();
        outbox_inputs_are_byte_stable();
        crate::btcc::subsessions::delegation_identities_are_byte_stable();
        crate::btcc::agent_loop::tests::stored_authority_continuation_with_every_field_is_byte_stable();
        crate::btcc::effects::workspace_file::tests::write_effect_normalized_input_is_byte_stable();
        crate::btcc::effects::workspace_edit::tests::edit_input_prepared_edit_and_receipt_are_byte_stable().await;
        crate::btcc::turn::payload_body_with_changed_files_is_byte_stable();
    }

    fn steward_packet_is_byte_stable() {
        assert_eq!(
            serde_json::to_string(&steward()).unwrap(),
            r#"{"child_role":"steward","delegation_id":"delegation","task_id":"task","parent_session_id":"parent-session","parent_turn_id":"parent-turn","parent_chat_id":"parent-chat","relation_id":"relation","access_mode":"full_access","execution_mode":"mutation","objective":"Do it","acceptance_criteria":["check"],"task_or_plan_refs":["plan"],"constraints_and_non_goals":[],"allowed_tools_and_effects":["edit_file:workspace"],"mutation_scope":["."],"parent_work_ref":{"work_id":"work","session_id":"parent-session","turn_id":"parent-turn","plan_revision_id":"plan","review_revision_id":"review"},"model_ref":"provider/model","reasoning_effort":"medium"}"#
        );
    }

    fn worker_packet_is_byte_stable() {
        let mut packet = steward();
        packet.child_role = ChildRole::Worker;
        packet.source_tool_call_id = Some("call".into());
        packet.parent_chat_id = None;
        packet.implementation_brief = Some("brief".into());
        packet.plan_action = Some(PacketPlanAction {
            action_key: "a1".into(),
            description: "step".into(),
            dependency_keys: vec![],
        });
        packet.constraints_and_non_goals = vec!["bounded".into()];
        packet.worker_profile = Some(PacketWorkerProfile {
            id: "profile".into(),
            job: serde_json::json!({"kind":"code"}),
        });
        assert_eq!(
            serde_json::to_string(&packet).unwrap(),
            r#"{"child_role":"worker","delegation_id":"delegation","source_tool_call_id":"call","task_id":"task","parent_session_id":"parent-session","parent_turn_id":"parent-turn","relation_id":"relation","access_mode":"full_access","execution_mode":"mutation","objective":"Do it","acceptance_criteria":["check"],"implementation_brief":"brief","plan_action":{"action_key":"a1","description":"step","dependency_keys":[]},"task_or_plan_refs":["plan"],"constraints_and_non_goals":["bounded"],"allowed_tools_and_effects":["edit_file:workspace"],"mutation_scope":["."],"parent_work_ref":{"work_id":"work","session_id":"parent-session","turn_id":"parent-turn","plan_revision_id":"plan","review_revision_id":"review"},"worker_profile":{"id":"profile","job":{"kind":"code"}},"model_ref":"provider/model","reasoning_effort":"medium"}"#
        );
    }

    fn dispatch_intent_is_byte_stable() {
        let mut intent = DispatchIntent::fixture();
        intent.envelope.peer.parent_id = Some("parent".into());
        assert_eq!(
            serde_json::to_string(&intent).unwrap(),
            r#"{"envelope":{"eventId":"event","transport":"app","accountId":"local","peer":{"kind":"dm","id":"child","parentId":"parent"},"sender":{"id":"sender","displayName":"Sender"},"message":{"id":"message","text":"text","timestamp":"now"},"routingHints":{"sessionId":"child","turnId":"turn"},"nativeStewardContext":{"version":1,"role":"steward","projectName":"","workspacePath":"/tmp","modelRef":"provider/model","reasoningEffort":"medium"},"raw":{"source":"fixture"}},"metadata":{"source":"fixture"}}"#
        );
    }

    fn outbox_inputs_are_byte_stable() {
        let worker = ParentResultInput::StewardQueue(WorkerResultInput {
            text: "t".into(),
            model_ref: "m".into(),
            reasoning_effort: "r".into(),
            timestamp: "now".into(),
        });
        assert_eq!(
            serde_json::to_string(&worker).unwrap(),
            r#"{"route":"steward_queue","text":"t","model_ref":"m","reasoning_effort":"r","timestamp":"now"}"#
        );
        let steward = ParentResultInput::ButlerApp(StewardResultInput {
            relation_id: "rel".into(),
            result_id: "res".into(),
            parent_session_id: "ps".into(),
            parent_turn_id: "pt".into(),
            parent_chat_id: "pc".into(),
            message_id: "msg".into(),
            safe_title: "Delegated result".into(),
            text: "t".into(),
            model_ref: "m".into(),
            reasoning_effort: "r".into(),
            access_mode: "a".into(),
            timestamp: "now".into(),
        });
        assert_eq!(
            serde_json::to_string(&steward).unwrap(),
            r#"{"route":"butler_app","relation_id":"rel","result_id":"res","parent_session_id":"ps","parent_turn_id":"pt","parent_chat_id":"pc","message_id":"msg","safe_title":"Delegated result","text":"t","model_ref":"m","reasoning_effort":"r","access_mode":"a","timestamp":"now"}"#
        );
    }
}
