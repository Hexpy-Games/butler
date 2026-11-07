//! The UI's only data boundary. A [`Source`] reads Butler's chats, message windows and
//! authority requests and sends what the UI does; it mirrors `butler-shell-client`
//! (`list_chats`, `message_window`, `authority_requests`, `live_events(cursor)`,
//! `cancel_turn`, `answer_authority`) and is adapted by `agent`. Without a source the shell shows its disconnected state.
pub(crate) mod agent;
pub(crate) mod model;
pub(crate) mod wire;

use futures::future::LocalBoxFuture;
use futures::stream::LocalBoxStream;

pub(crate) use model::{
    Approval, AuthorityCard, CardKind, ChatId, ChatPage, ChatRef, ChatSummary, Decision,
    EventCursor, LiveEvent, LiveUpdate, PageCursor, RequestRef, Risk, SentTurn, SessionId, Space,
    Timestamp, TurnId,
};

/// Why a request failed, in the UI's terms (no credential or wire detail).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SourceError {
    /// The agent is not running or the connection dropped.
    Disconnected,
    /// A required route is missing; preserve chats and ask for an update.
    Incompatible,
    /// The resource is gone; the connection stays attached.
    Missing,
    /// The agent refused the request.
    Refused(String),
}

/// A request in flight.
pub(crate) type Fetch<T> = LocalBoxFuture<'static, Result<T, SourceError>>;

pub(crate) enum SessionAction {
    Rename(String),
    Archive,
    Delete,
}

pub(crate) trait Source {
    fn summary(&self, _: &SessionId) -> Fetch<wire::SessionSummaryView> {
        Box::pin(async { Err(SourceError::Missing) })
    }
    fn settings(&self) -> Fetch<wire::FrameSettings> {
        Box::pin(async { Err(SourceError::Missing) })
    }
    fn session_action(&self, _: &SessionId, _: SessionAction) -> Fetch<()> {
        Box::pin(async { Err(SourceError::Missing) })
    }
    /// One page of chats, newest activity first; `None` starts a fresh snapshot.
    fn chats(&self, cursor: Option<PageCursor>) -> Fetch<ChatPage>;
    /// Opens a session: its latest view, and the composer's controls for it.
    fn open_session(&self, session: &SessionId) -> Fetch<wire::SessionView>;
    /// A session's latest view again (`before` `None`), or the message window before `before`
    /// (a `previous_cursor_token`).
    fn session_view(&self, session: &SessionId, before: Option<String>)
    -> Fetch<wire::SessionView>;
    /// A session's outstanding authority requests, in the agent's order.
    fn authority(&self, session: &SessionId) -> Fetch<Vec<AuthorityCard>>;
    /// Live updates after `after` (a snapshot's cursor); ends when the connection drops.
    fn live(&self, after: EventCursor) -> LocalBoxStream<'static, LiveEvent>;
    /// Starts a new chat (its session too).
    fn create_chat(&self) -> Fetch<ChatRef>;
    /// Stops a running turn.
    fn cancel(&self, turn: &TurnId) -> Fetch<()>;
    /// Answers one of `session`'s authority requests.
    fn answer(&self, session: &SessionId, request: &RequestRef, decision: Decision) -> Fetch<()>;
}
