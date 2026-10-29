use serde::Deserialize;
use serde_json::Value;

/// Result of local instance discovery. Absence never triggers network access.
#[derive(Debug)]
pub enum AttachState {
    /// A ready, enabled instance with a living PID and a readable credential.
    Connected(crate::ShellClient),
    /// No valid running instance record exists.
    NotRunning,
}

/// Credential-safe errors: response bodies, headers and tokens are never included.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Local discovery or credential read failed.
    #[error("local agent metadata is unavailable")]
    LocalMetadata,
    /// Invalid paging arguments.
    #[error("page size must be between 1 and 200")]
    InvalidPage,
    /// Network failure (details deliberately omitted).
    #[error("agent connection failed")]
    Connection,
    /// The gateway rejected both the cached credential and its refresh.
    #[error("agent authentication failed")]
    Authentication,
    /// HTTP failure after the single permitted credential refresh.
    #[error("agent returned HTTP {0}")]
    Http(u16),
    /// A response does not match the wire contract.
    #[error("invalid agent response")]
    Protocol,
    /// A retained event gap cannot be recovered without losing content.
    #[error("agent event history has a gap after cursor {0}")]
    EventGap(u64),
}

/// Bounded list request, ordered as the gateway orders chats or sessions.
#[derive(Clone, Debug)]
pub struct PageRequest {
    pub(crate) limit: u32,
    pub(crate) cursor: Option<String>,
}
impl PageRequest {
    /// Request 1..=200 records after an opaque cursor; None starts a traversal.
    pub fn new(limit: u32, cursor: Option<String>) -> Result<Self, Error> {
        if !(1..=200).contains(&limit) {
            return Err(Error::InvalidPage);
        }
        Ok(Self { limit, cursor })
    }
}

/// A bounded list of complete wire records; no fields are removed.
#[derive(Debug, Deserialize)]
pub struct Page {
    /// Durable cursor captured before the list read, for lossless live continuation.
    pub event_cursor: u64,
    /// Complete chat/session records.
    pub items: Vec<Value>,
    /// Opaque snapshot/keyset cursor for the next page, or None at the end.
    pub next_cursor: Option<String>,
}

/// One bounded message window, in ascending row cursor order.
#[derive(Debug, Deserialize)]
pub struct MessagePage {
    /// Complete messages, including all content and status fields.
    pub messages: Vec<Value>,
    /// Pass to get_messages to read the next window; an empty window ends paging.
    #[serde(deserialize_with = "wire_cursor")]
    pub next_cursor: u64,
    /// All additional page fields (including turn progress).
    #[serde(flatten)]
    pub metadata: serde_json::Map<String, Value>,
}

/// Durable events replayed in ascending cursor order.
#[derive(Debug, Deserialize)]
pub struct EventPage {
    /// Complete event envelopes, including unknown event kinds.
    pub events: Vec<Value>,
    /// Cursor of the last record, unchanged on an empty page.
    #[serde(deserialize_with = "wire_cursor")]
    pub next_cursor: u64,
}

/// An authority card with the gateway's original action presentation intact.
#[derive(Clone, Debug)]
pub struct AuthorityRequest {
    /// Reference to use when answering this request.
    pub request_ref: String,
    /// Exact, unmodified reason text supplied by the agent.
    pub reason: String,
    /// Exact action summary, including targets, examples and truncation markers.
    /// Render these fields without replacing them with an inferred action.
    pub approval: Value,
    /// Complete card, including question/input fields for non-approval requests.
    pub raw: Value,
}

/// Session authority state.
#[derive(Debug)]
pub struct AuthorityPage {
    /// Outstanding cards in the server's order.
    pub requests: Vec<AuthorityRequest>,
    /// Complete response, including permissions.
    pub raw: Value,
}

/// A decision sent only through the authority ingress.
#[derive(Debug)]
pub enum AuthorityDecision {
    /// Allow the reviewed action with a gateway-supported scope.
    Allow {
        /// once, conversation or site.
        scope: String,
    },
    /// Refuse the reviewed action.
    Deny,
    /// Request a changed action.
    Modify {
        /// Exact replacement instruction.
        instruction: String,
    },
    /// Answer a question with the gateway's structured answer schema.
    Answer(Value),
}

/// Known live event categories; future event types remain observable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventKind {
    /// A committed or provisional message.
    Message,
    /// A turn's state changed.
    TurnState,
    /// The gateway authentication code changed.
    TokenRotated,
    /// Every unrecognized type, with its original name.
    Unknown(String),
}

/// One live envelope. Unknown kinds retain their entire original JSON.
#[derive(Clone, Debug)]
pub struct LiveEvent {
    /// Durable cursor; provisional drafts have none and are not replayable.
    pub cursor: Option<u64>,
    /// Typed category without discarding unknown kinds.
    pub kind: EventKind,
    /// Complete original envelope.
    pub raw: Value,
}

fn wire_cursor<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = serde_json::Number::deserialize(deserializer)?;
    if let Some(cursor) = value.as_u64() {
        return Ok(cursor);
    }
    let cursor = value
        .as_f64()
        .ok_or_else(|| serde::de::Error::custom("invalid cursor"))?;
    if cursor < 0.0 || cursor > 9_007_199_254_740_991.0 || cursor.fract() != 0.0 {
        return Err(serde::de::Error::custom("invalid cursor"));
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "validated exact nonnegative JS integer"
    )]
    Ok(cursor as u64)
}
