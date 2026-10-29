//! The view model a [`super::Source`] fills, shaped like `butler-shell-client`: chats and
//! sessions are separate ids, lists page with opaque keyset cursors, every snapshot carries the
//! event cursor live updates continue from, and authority requests keep the gateway's typed
//! approval as it was sent.
#![allow(
    dead_code,
    reason = "the agent client adapter (W3) builds these from butler-shell-client; until then only the harness and tests do"
)]
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

/// A caller-made message id: sending twice with the same id sends once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClientMessageId(pub(crate) String);

/// An opaque keyset cursor into the chat list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PageCursor(pub(crate) String);

/// An opaque cursor to the window before a message window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MessageCursor(pub(crate) String);

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
#[derive(Clone, Debug)]
pub(crate) struct ChatSummary {
    pub(crate) chat: ChatRef,
    pub(crate) title: SharedString,
    pub(crate) space: Option<Space>,
    pub(crate) pinned: bool,
    pub(crate) running: bool,
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

/// A window of a session's messages in display order (oldest first).
pub(crate) struct MessagePage {
    pub(crate) messages: Vec<Message>,
    /// Where the window before this one starts; `None` at the beginning of the chat.
    pub(crate) older: Option<MessageCursor>,
    /// The chat's running turn, if any.
    pub(crate) running: Option<TurnId>,
    /// The event cursor of this snapshot.
    pub(crate) events: EventCursor,
}

/// What an authority request asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CardKind {
    /// Run a command.
    Command,
    /// Carry out a reviewed effect (file change, schedule, browser step, ...).
    ReviewedEffect,
    /// Answer the agent's questions.
    Question,
    /// A kind this build does not know, with the agent's name for it.
    Other(SharedString),
}

impl CardKind {
    /// Whether this build can decide the request (allow once, deny, suggest a change).
    pub(crate) fn decidable(&self) -> bool {
        matches!(self, Self::Command | Self::ReviewedEffect)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Risk {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    ReadOnly,
    Change,
}

/// The exact local decision facts of a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Operation {
    pub(crate) tool: SharedString,
    pub(crate) access: Access,
    pub(crate) targets: Vec<SharedString>,
    /// The command line as sent, for commands.
    pub(crate) command: Option<SharedString>,
}

/// One thing a request touches; never an absolute path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) kind: SharedString,
    pub(crate) path: SharedString,
    pub(crate) label: Option<SharedString>,
}

/// The gateway's `approval`, typed but unchanged: the card shows these strings as sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Approval {
    pub(crate) action_kind: SharedString,
    pub(crate) operation: Option<Operation>,
    pub(crate) targets: Vec<Target>,
    pub(crate) count: u32,
    /// Up to three concrete items (relative paths, or the command line as sent).
    pub(crate) examples: Vec<SharedString>,
    /// One flag per example: the gateway cut it at its safety cap.
    pub(crate) examples_truncated: Vec<bool>,
    pub(crate) risk: Option<Risk>,
}

impl Approval {
    /// The exact action text: the command as sent, else the first example, else the first
    /// target, each unchanged.
    pub(crate) fn action(&self) -> Option<SharedString> {
        let command = self.operation.as_ref().and_then(|o| o.command.clone());
        command
            .or_else(|| self.examples.first().cloned())
            .or_else(|| {
                self.targets
                    .first()
                    .map(|t| t.label.clone().unwrap_or(t.path.clone()))
            })
    }
}

/// An outstanding authority request.
#[derive(Clone, Debug)]
pub(crate) struct AuthorityCard {
    pub(crate) request: RequestRef,
    pub(crate) kind: CardKind,
    /// The agent's reason, unchanged.
    pub(crate) reason: SharedString,
    pub(crate) approval: Option<Approval>,
}

/// How far an allow reaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AllowScope {
    Conversation,
    Site,
}

/// One answered question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct QuestionAnswer {
    pub(crate) id: SharedString,
    pub(crate) selected: Vec<SharedString>,
    pub(crate) custom: Option<String>,
    pub(crate) skipped: bool,
}

/// A decision on an authority request (the client's allow, deny, modify and answer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    AllowOnce,
    Allow(AllowScope),
    Deny,
    /// Suggest a different approach (exact instruction).
    Modify(String),
    Answer(Vec<QuestionAnswer>),
}

/// The composer's labels for the open chat.
#[derive(Clone, Debug)]
pub(crate) struct ComposerContext {
    pub(crate) permission: SharedString,
    pub(crate) model: SharedString,
    pub(crate) effort: SharedString,
}

/// A message was sent and its turn started.
pub(crate) struct SentTurn {
    pub(crate) turn: TurnId,
}

/// One live change.
pub(crate) enum LiveUpdate {
    /// A message was added or changed (streamed text grows in place).
    Message {
        session: SessionId,
        message: Message,
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
}

/// A live update and its durable cursor (drafts have none).
pub(crate) struct LiveEvent {
    pub(crate) cursor: Option<EventCursor>,
    pub(crate) update: LiveUpdate,
}
