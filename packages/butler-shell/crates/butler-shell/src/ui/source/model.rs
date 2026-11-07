//! The view model a [`super::Source`] fills, shaped like `butler-shell-client`: chats and
//! sessions are separate ids, lists page with opaque keyset cursors, every snapshot carries the
//! event cursor live updates continue from, and authority requests keep the gateway's typed
//! approval as it was sent.
use gpui::SharedString;

/// Chat identity as the agent names it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ChatId(pub(crate) SharedString);

/// The session behind a chat (message windows and authority requests are per session).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct SessionId(pub(crate) SharedString);

/// A chat and its session.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ChatRef {
    pub(crate) chat: ChatId,
    pub(crate) session: SessionId,
}

/// A running turn's identity (to cancel it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TurnId(pub(crate) SharedString);

/// An authority request's reference (to answer it).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct RequestRef(pub(crate) SharedString);

/// An opaque keyset cursor into the chat list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageCursor(pub(crate) String);

/// A durable event cursor: live updates resume after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct EventCursor(pub(crate) u64);

/// Milliseconds since the Unix epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Timestamp(pub(crate) i64);

/// The space a chat belongs to (a group or a project).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Space {
    pub(crate) id: SharedString,
    pub(crate) title: SharedString,
    pub(crate) project: bool,
}

/// One chat row.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent session flags from the wire"
)]
#[derive(Clone, Debug)]
pub(crate) struct ChatSummary {
    pub(crate) chat: ChatRef,
    pub(crate) title: SharedString,
    pub(crate) space: Option<Space>,
    pub(crate) pinned: bool,
    pub(crate) archived: bool,
    pub(crate) created_at: Timestamp,
    pub(crate) running: bool,
    pub(crate) waiting: bool,
    /// Last activity (the row shows its age, formatted when drawn).
    pub(crate) updated_at: Timestamp,
}

/// One page of chats, newest activity first.
pub(crate) struct ChatPage {
    pub(crate) chats: Vec<ChatSummary>,
    pub(crate) next: Option<PageCursor>,
    /// The event cursor of this snapshot.
    pub(crate) events: EventCursor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Risk {
    Low,
    Medium,
    High,
}

/// An outstanding authority request: its ref, and the tool of its operation when it names one.
#[derive(Clone, Debug)]
pub(crate) struct AuthorityCard {
    pub(crate) request: RequestRef,
    pub(crate) tool: Option<SharedString>,
}

/// A message was sent and its turn started.
pub(crate) struct SentTurn {
    pub(crate) turn: TurnId,
}

/// One live change.
pub(crate) enum LiveUpdate {
    /// An individual live projection failed.
    Failed(super::SourceError),
    /// A live event the open session's transcript and turn progress read: message created,
    /// updated or deleted, a turn state change, or a progress row. `event` is the gateway
    /// envelope as sent.
    Event {
        session: SessionId,
        event: Box<super::wire::AppEventEnvelope>,
    },
    /// A chat's turn started (`Some`) or ended (`None`).
    Turn {
        chat: ChatId,
        running: Option<TurnId>,
    },
    /// A session's authority requests changed.
    Authority {
        session: SessionId,
        cards: Vec<AuthorityCard>,
    },
    /// A chat row was added or changed.
    Chat(ChatSummary),
    /// The stream lost events it cannot replay: reload what is shown.
    Resync,
    /// An event the inspector's own readers follow (canon queue, task graphs, reconcile).
    Inspector(Box<super::wire::AppEventEnvelope>),
}

/// A live update and its durable cursor (drafts have none).
pub(crate) struct LiveEvent {
    pub(crate) cursor: Option<EventCursor>,
    pub(crate) update: LiveUpdate,
}
