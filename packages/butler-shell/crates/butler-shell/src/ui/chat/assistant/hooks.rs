//! What the assistant body needs from the shell and the app: developer mode, opening a session
//! and opening a log trace (`useDeveloperMode`, `openSession`, `openLogTrace`), and the turn
//! being retried (`store.retryingTurnId`). The shell installs [`AssistantHooks`] as a global.
use std::rc::Rc;

use gpui::{App, Global};

use crate::ui::source::wire::MessageRecord;

/// The trace behind a message (messageTrace.ts `LogTraceTarget`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TraceTarget {
    Turn(String),
    Message { chat_id: String, message_id: String },
}

/// The trace behind a message: its turn's, else the persisted message's; none for a message not
/// yet stored (`messageTraceTarget`).
pub(crate) fn trace_target(message: &MessageRecord) -> Option<TraceTarget> {
    if let Some(turn_id) = message.turn_id.as_ref().filter(|id| !id.is_empty()) {
        return Some(TraceTarget::Turn(turn_id.clone()));
    }
    let chat_id = message.chat_id.as_ref().filter(|id| !id.is_empty())?;
    (!message.id.is_empty()).then(|| TraceTarget::Message {
        chat_id: chat_id.clone(),
        message_id: message.id.clone(),
    })
}

#[derive(Clone, Default)]
pub(crate) struct AssistantHooks {
    pub(crate) developer_mode: bool,
    /// Opens a session by id (after a branch is created, or for the branch source).
    pub(crate) open_session: Option<Rc<dyn Fn(&str, &mut App)>>,
    pub(crate) open_trace: Option<Rc<dyn Fn(&TraceTarget, &mut App)>>,
}

impl Global for AssistantHooks {}

pub(super) fn hooks(cx: &App) -> AssistantHooks {
    cx.try_global::<AssistantHooks>()
        .cloned()
        .unwrap_or_default()
}

/// The turn a retry is in flight for.
#[derive(Default)]
struct Retrying(Option<String>);

impl Global for Retrying {}

pub(super) fn retrying(turn_id: &str, cx: &App) -> bool {
    cx.try_global::<Retrying>()
        .is_some_and(|retrying| retrying.0.as_deref() == Some(turn_id))
}

pub(super) fn set_retrying(turn_id: Option<String>, cx: &mut App) {
    cx.set_global(Retrying(turn_id));
}
