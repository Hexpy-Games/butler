//! The UI's only data boundary. A [`Source`] reads Butler's chats, message windows and
//! authority requests and sends what the UI does; it mirrors `butler-shell-client`
//! (`list_chats`, `message_window`, `authority_requests`, `live_events(cursor)`,
//! `post_message` with a client message id, `cancel_turn`, `answer_authority`) and is adapted
//! by `agent`. Without a source the shell shows its disconnected state.
pub(crate) mod agent;
pub(crate) mod model;

use futures::future::LocalBoxFuture;
use futures::stream::LocalBoxStream;

pub(crate) use model::{
    ActivityItem, Approval, AuthorityCard, CardKind, ChatId, ChatPage, ChatRef, ChatSummary,
    ClientMessageId, ComposerContext, Decision, EventCursor, LiveEvent, LiveUpdate, Message,
    MessageCursor, MessagePage, PageCursor, RequestRef, Risk, Role, SentTurn, SessionId, Space,
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

pub(crate) trait Source {
    /// One page of chats, newest activity first; `None` starts a fresh snapshot.
    fn chats(&self, cursor: Option<PageCursor>) -> Fetch<ChatPage>;
    /// A session's latest message window, or the window before `before`.
    fn messages(&self, session: &SessionId, before: Option<MessageCursor>) -> Fetch<MessagePage>;
    /// A session's outstanding authority requests, in the agent's order.
    fn authority(&self, session: &SessionId) -> Fetch<Vec<AuthorityCard>>;
    /// Live updates after `after` (a snapshot's cursor); ends when the connection drops.
    fn live(&self, after: EventCursor) -> LocalBoxStream<'static, LiveEvent>;
    /// Starts a new chat (its session too).
    fn create_chat(&self) -> Fetch<ChatRef>;
    /// Sends `text` into `chat` and starts its turn; `id` makes a retry send once.
    fn send(&self, chat: &ChatId, id: ClientMessageId, text: String) -> Fetch<SentTurn>;
    /// Stops a running turn.
    fn cancel(&self, turn: &TurnId) -> Fetch<()>;
    /// Answers one of `session`'s authority requests.
    fn answer(&self, session: &SessionId, request: &RequestRef, decision: Decision) -> Fetch<()>;
    /// The composer's permission and model labels.
    fn composer(&self) -> ComposerContext;
}
