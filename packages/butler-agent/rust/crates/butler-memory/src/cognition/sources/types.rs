use std::borrow::Cow;

/// Which conversation source a memory registration covers.
#[derive(Clone, Copy, Debug)]
pub enum ConversationSourceNotice<'a> {
    /// A finished turn: its request and public answer.
    Turn {
        /// Conversation session.
        session_id: &'a str,
        /// Turn id.
        turn_id: &'a str,
        /// Generation of the turn outcome the registration saw.
        outcome_generation: f64,
        /// Extraction version the source is registered under.
        extraction_version: &'a str,
    },
    /// A recovered message outside any turn.
    Standalone {
        /// Conversation session.
        session_id: &'a str,
        /// Message id.
        message_id: &'a str,
        /// Recovered-parts hash of the message.
        source_hash: &'a str,
        /// Extraction version the source is registered under.
        extraction_version: &'a str,
    },
}

/// What preparing a conversation source produced.
#[derive(Clone, Debug, PartialEq)]
pub enum PreparedConversationSource {
    /// The source plan to register.
    Plan(Box<CognitionSourcePlan>),
    /// The turn was internal control; its earlier registration is superseded instead.
    SupersedeInternalControl {
        /// The internal-control turn.
        turn_id: String,
    },
}

/// An episode and the source rows to register for one conversation source.
#[derive(Clone, Debug, PartialEq)]
pub struct CognitionSourcePlan {
    /// Stable key of the source (`conversation_turn:…` or `conversation_message:…`).
    pub source_key: String,
    /// Episode id derived from the source key.
    pub episode_id: String,
    /// Episode revision: a hash of every scalar and the revision tail.
    pub revision: String,
    /// Projection job id for this revision and extraction version.
    pub job_id: String,
    /// Extraction version.
    pub extraction_version: String,
    /// Conversation session.
    pub session_id: String,
    /// Turn id, for a turn source.
    pub turn_id: Option<String>,
    /// When the conversation began.
    pub conversation_start: String,
    /// When the conversation ended.
    pub conversation_end: String,
    /// Hash identifying this source revision.
    pub source_hash: String,
    /// Combined origin of the messages (`user_input`, `mixed`, …).
    pub origin_kind: String,
    /// One row per scalar span.
    pub rows: Vec<CognitionSourceRow>,
    /// Extraction windows, each a list of source ids.
    pub windows: Vec<Vec<String>>,
}

/// One span of source text an episode rests on.
#[derive(Clone, Debug, PartialEq)]
pub struct CognitionSourceRow {
    /// Source id (a hash of the span identity).
    pub source_id: String,
    /// Episode the span belongs to.
    pub episode_id: String,
    /// Episode revision.
    pub revision: String,
    /// `conversation`, `task_report` or `explicit_record`.
    pub source_kind: String,
    /// Conversation session, for conversation spans.
    pub conversation_session_id: Option<String>,
    /// Message, for conversation spans.
    pub conversation_message_id: Option<String>,
    /// Message part (or typed record id).
    pub part_id: String,
    /// JSON pointer of the scalar inside the part.
    pub scalar_pointer: String,
    /// Start of the span, in bytes.
    pub byte_start: f64,
    /// End of the span, in bytes.
    pub byte_end: f64,
    /// SHA-256 of the scalar text.
    pub content_hash: String,
    /// Author role.
    pub role: String,
    /// How the message entered the conversation.
    pub origin_kind: String,
    /// When the source text was observed.
    pub observed_at: String,
    /// How the text supports memories (`user_statement`, `assistant_statement`, …).
    pub basis: String,
}

#[derive(Debug, PartialEq)]
pub struct HydratedConversationSource<'a> {
    pub source_ref: &'a str,
    pub text: &'a str,
    pub excerpt: Cow<'a, str>,
    pub byte_start: f64,
    pub byte_end: f64,
    pub source_hash: &'a str,
    pub conversation_session_id: Option<&'a str>,
    pub conversation_message_id: Option<&'a str>,
    pub basis: &'a str,
    pub origin_kind: &'a str,
    pub scalar_text: &'a str,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct PriorPublicContext {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub text: String,
    pub observed_at: String,
    pub basis: String,
}

/// Source readers report ordinary Cognition errors.
pub(crate) type CognitionSourceError = crate::cognition::CognitionError;
