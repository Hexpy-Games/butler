//! Contracts of authority decisions, bounded continuation, context projection, closeout and replay.

use super::*;

/// The user's answer to a pending authority request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AuthorityDecision {
    Allow,
    Deny,
    Modify { input: String },
}

/// The context-budget envelope attached to a bounded provider request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedContinuationEnvelope {
    pub schema_version: BoundedEnvelopeV1,
    pub model_facing_bytes: u64,
    pub request_digest: String,
    pub response_item_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_projection: Option<ContextProjectionRebaseIdentity>,
}

/// Schema tag of [`BoundedContinuationEnvelope`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundedEnvelopeV1 {
    #[serde(rename = "butler.turn-context-envelope.v1")]
    V1,
}

/// Identifies the rolling-context projection a request was rebased onto.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextProjectionRebaseIdentity {
    pub schema_version: ContextProjectionRebaseV1,
    pub projection_revision: RollingContextV1,
    pub projection_digest: String,
    pub projected_through_ordinal: usize,
}

/// Schema tag of [`ContextProjectionRebaseIdentity`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContextProjectionRebaseV1 {
    #[serde(rename = "butler.context-projection-rebase.v1")]
    V1,
}

/// Revision tag of the rolling-context projection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RollingContextV1 {
    #[serde(rename = "butler.rolling-context.v1")]
    V1,
}

/// What the context port needs to project one round's messages.
pub struct ContextProjectionInput<'a> {
    pub round_id: &'a str,
    pub response_item_id: &'a str,
    pub semantic_messages: &'a [ModelRoundMessage],
    pub transport_messages: &'a [ModelRoundMessage],
    pub model_ref: &'a str,
    pub instructions: Option<&'a str>,
    pub tools: &'a [ModelRoundTool],
    pub tool_choice: Option<ToolChoice>,
    /// Admitted image attachments (provider passthrough JSON).
    pub attachments: &'a [Value],
    pub butler_data: Option<&'a str>,
    pub max_model_facing_bytes: u64,
}

/// Which message list a projected round sends to the provider.
pub enum ContextMessages {
    /// The loop's semantic transcript as is.
    Semantic,
    /// The operation-result replay of the transcript.
    Transport,
    /// A projection-owned (compacted or rebased) transcript.
    Owned(Vec<ModelRoundMessage>),
}

/// Whether a projection moved the rolling context, and whether steering must
/// be re-read before the request because the rebase may hide a new user turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextRebase {
    NotRequired,
    Required,
    RequiredWithSteeringRecheck,
}

/// The context port's projection of one round.
pub struct ContextProjection {
    pub messages: ContextMessages,
    pub bounded_continuation: Option<BoundedContinuationEnvelope>,
    pub provider_body_admission: Option<Box<dyn super::super::ports::ProviderBodyAdmissionPort>>,
    pub rebase: ContextRebase,
}

pub(crate) struct CloseoutInput<'a> {
    pub content: &'a str,
    pub suspension: Option<crate::btcc::SuspensionReason>,
}

pub(crate) struct GuidedCloseout {
    pub content: String,
    pub work_status: Option<WorkStatus>,
    pub accepted_work_result: Option<AcceptedWorkResult>,
    pub runtime_failure: Option<RuntimeFailure>,
    pub artifacts: Vec<FinalArtifact>,
    /// Journal-owned change records, forwarded to the final payload unchanged.
    pub changed_files: Vec<crate::btcc::ChangedFileSummary>,
    pub model_identity: Option<ModelIdentity>,
    pub has_final_work: bool,
}

/// A user message that arrived while the turn was running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SteeringObservation {
    pub content: String,
    pub request_segment_kind: String,
}

/// The operation-result replay of a round's transcript, when the runtime rewrote it.
#[derive(Clone, Debug, PartialEq)]
pub struct ReplayPreparation {
    pub messages: Option<Vec<ModelRoundMessage>>,
}

/// The journal's verdict on tool calls written as text.
#[derive(Clone, Debug, PartialEq)]
pub enum TextCallDisposition {
    Continue(String),
    Fail(BtccError),
}
