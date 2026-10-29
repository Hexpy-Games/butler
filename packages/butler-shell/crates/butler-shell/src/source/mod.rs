//! The UI's only data boundary. A [`Source`] reads Butler's chats, messages and authority
//! requests and sends what the UI does (a message, a cancel, an authority answer); it is shaped
//! like the agent client crate `butler-shell-client` (paged lists with opaque cursors, a
//! resumable live stream with a resync signal) and is adapted to it in a later step. Without
//! a source the shell shows its disconnected state.
pub(crate) mod model;

use futures::future::LocalBoxFuture;
use futures::stream::LocalBoxStream;

pub(crate) use model::{
    ActivityItem, AuthorityCard, ChatId, ChatPage, ChatSummary, ComposerContext, Decision,
    LiveUpdate, Message, MessageCursor, MessagePage, PageCursor, Role, SentTurn, Space, TurnId,
};

/// Why a request failed, in the UI's terms (no credential or wire detail).
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(dead_code, reason = "the agent client adapter (W3) reports these")]
pub(crate) enum SourceError {
    /// The agent is not running or the connection dropped.
    Disconnected,
    /// The agent refused the request (shown as a brief toast).
    Refused(String),
}

/// A request in flight.
pub(crate) type Fetch<T> = LocalBoxFuture<'static, Result<T, SourceError>>;

pub(crate) trait Source {
    /// One page of chats, newest activity first; `None` starts at the top.
    fn chats(&self, cursor: Option<PageCursor>) -> Fetch<ChatPage>;
    /// The latest window of a chat's messages, or the window before `before`.
    fn messages(&self, chat: &ChatId, before: Option<MessageCursor>) -> Fetch<MessagePage>;
    /// The chat's outstanding authority requests, in the agent's order.
    fn authority(&self, chat: &ChatId) -> Fetch<Vec<AuthorityCard>>;
    /// Live updates from now on; ends when the connection drops.
    fn live(&self) -> LocalBoxStream<'static, LiveUpdate>;
    /// Sends `text` into `chat` (a new chat when `None`) and starts its turn.
    fn send(&self, chat: Option<ChatId>, text: String) -> Fetch<SentTurn>;
    /// Stops a running turn.
    fn cancel(&self, turn: TurnId) -> Fetch<()>;
    /// Answers an authority request.
    fn answer(&self, request: String, decision: Decision) -> Fetch<()>;
    /// The composer's permission and model labels.
    fn composer(&self) -> ComposerContext;
}
