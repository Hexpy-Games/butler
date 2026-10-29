//! The view model a [`super::Source`] fills: only what the UI shows, in the UI's types.
use gpui::SharedString;

/// Chat identity as the agent names it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ChatId(pub(crate) SharedString);

/// A running turn's identity (to cancel it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TurnId(pub(crate) SharedString);

/// An opaque keyset cursor into the chat list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageCursor(pub(crate) String);

/// An opaque cursor into one chat's messages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MessageCursor(pub(crate) String);

/// The space a chat belongs to (a group or a project).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Space {
    pub(crate) id: SharedString,
    pub(crate) title: SharedString,
    pub(crate) project: bool,
}

/// One chat row.
#[derive(Clone, Debug)]
pub(crate) struct ChatSummary {
    pub(crate) id: ChatId,
    pub(crate) title: SharedString,
    pub(crate) space: Option<Space>,
    pub(crate) pinned: bool,
    pub(crate) running: bool,
    /// Last activity, as the agent words its age ("12분 전").
    pub(crate) age: SharedString,
}

pub(crate) struct ChatPage {
    pub(crate) chats: Vec<ChatSummary>,
    pub(crate) next: Option<PageCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the agent client adapter (W3) builds replies")
)]
pub(crate) enum Role {
    User,
    Assistant,
}

/// A tool call shown under an activity step.
#[derive(Clone, Debug)]
pub(crate) struct ToolChip {
    /// One of the bundled glyph names (terminal, file, ...).
    pub(crate) icon: &'static str,
    pub(crate) title: SharedString,
}

/// One step of a turn's activity.
#[derive(Clone, Debug)]
pub(crate) struct ActivityItem {
    pub(crate) title: SharedString,
    pub(crate) tools: Vec<ToolChip>,
}

#[derive(Clone, Debug)]
pub(crate) struct Message {
    pub(crate) id: SharedString,
    pub(crate) role: Role,
    /// Markdown for assistant messages, plain text for the user's.
    pub(crate) text: String,
    pub(crate) activity: Vec<ActivityItem>,
    /// Still being written by a running turn.
    pub(crate) streaming: bool,
}

/// A window of messages in display order (oldest first).
pub(crate) struct MessagePage {
    pub(crate) messages: Vec<Message>,
    /// Where the window before this one starts; `None` at the beginning of the chat.
    pub(crate) older: Option<MessageCursor>,
    /// The chat's running turn, if any.
    pub(crate) running: Option<TurnId>,
}

/// An authority request as the card shows it. `action` is the agent's exact action text and is
/// rendered unchanged.
#[derive(Clone, Debug)]
pub(crate) struct AuthorityCard {
    pub(crate) request: SharedString,
    /// What kind of permission ("명령 실행", ...).
    pub(crate) kind: SharedString,
    pub(crate) action: SharedString,
    pub(crate) details: Vec<SharedString>,
    /// The agent's risk label, when it gives one.
    pub(crate) risk: Option<SharedString>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    AllowOnce,
    Deny,
}

/// The composer's labels for the open chat.
#[derive(Clone, Debug)]
pub(crate) struct ComposerContext {
    pub(crate) permission: SharedString,
    pub(crate) model: SharedString,
    pub(crate) effort: SharedString,
}

/// A message was sent: the chat it went to (new or existing) and its turn.
pub(crate) struct SentTurn {
    pub(crate) chat: ChatId,
    pub(crate) turn: TurnId,
}

/// One live change.
#[expect(dead_code, reason = "the agent client adapter (W3) streams these")]
pub(crate) enum LiveUpdate {
    /// A message was added or changed (streamed text grows in place).
    Message { chat: ChatId, message: Message },
    /// A chat's turn started (`Some`) or ended (`None`).
    Turn {
        chat: ChatId,
        running: Option<TurnId>,
    },
    /// A chat's authority requests changed.
    Authority {
        chat: ChatId,
        cards: Vec<AuthorityCard>,
    },
    /// A chat row was added or changed.
    Chat(ChatSummary),
    /// The stream lost events: reload what is shown.
    Resync,
}
