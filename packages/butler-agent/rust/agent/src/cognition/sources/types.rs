use std::borrow::Cow;

use crate::conversation::ConversationError;

#[derive(Clone, Copy, Debug)]
pub(crate) enum ConversationSourceNotice<'a> {
    Turn {
        session_id: &'a str,
        turn_id: &'a str,
        outcome_generation: f64,
        extraction_version: &'a str,
    },
    Standalone {
        session_id: &'a str,
        message_id: &'a str,
        source_hash: &'a str,
        extraction_version: &'a str,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PreparedConversationSource {
    Plan(Box<CognitionSourcePlan>),
    SupersedeInternalControl { turn_id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CognitionSourcePlan {
    pub source_key: String,
    pub episode_id: String,
    pub revision: String,
    pub job_id: String,
    pub extraction_version: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub conversation_start: String,
    pub conversation_end: String,
    pub source_hash: String,
    pub origin_kind: String,
    pub rows: Vec<CognitionSourceRow>,
    pub windows: Vec<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CognitionSourceRow {
    pub source_id: String,
    pub episode_id: String,
    pub revision: String,
    pub source_kind: String,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub part_id: String,
    pub scalar_pointer: String,
    pub byte_start: f64,
    pub byte_end: f64,
    pub content_hash: String,
    pub role: String,
    pub origin_kind: String,
    pub observed_at: String,
    pub basis: String,
}

#[derive(Debug, PartialEq)]
pub(crate) struct HydratedConversationSource<'a> {
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
pub(crate) struct PriorPublicContext {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub text: String,
    pub observed_at: String,
    pub basis: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CognitionSourceError {
    pub code: &'static str,
    pub message: String,
}

impl CognitionSourceError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<ConversationError> for CognitionSourceError {
    fn from(error: ConversationError) -> Self {
        Self::new(error.code, error.message)
    }
}

impl std::fmt::Display for CognitionSourceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CognitionSourceError {}
