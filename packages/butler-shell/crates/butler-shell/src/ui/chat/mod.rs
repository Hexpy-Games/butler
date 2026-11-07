//! The conversation: the transcript of the open session (`Conversation`, `MessageList`). It
//! shows the session view the shell hands it through `list::transcript`; when the top row comes
//! into view and older messages exist, it asks for them (never the whole chat at once).
pub(crate) mod activity;
mod answers;
mod assistant;
mod content;
pub(crate) mod empty;
pub(crate) mod files;
mod footer_meta;
mod intro;
mod list;
mod message_markdown;
mod queue;
mod row;
mod user;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use butler_ds::ui::blocks::message_row::Entering;
use butler_ds::ui::context::Ds;
use gpui::{
    App, Context, Global, InteractiveElement as _, IntoElement, Render, Styled as _, Window, div,
};

use self::assistant::FooterMeta;
use crate::ui::smooth_scroll::SmoothScroll;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{QueuedMessageRecord, SessionQueueView, SessionView};

pub(crate) use assistant::AssistantHooks;
pub(crate) use intro::set_seen as set_chats_intro_seen;
pub(crate) use list::{OlderRequest, on_load_older};
pub(crate) use queue::{on_queue_changed, queue_changed};

/// How long a row that just arrived keeps its insert motion.
const ENTERING: Duration = Duration::from_secs(1);

/// What every transcript unit reads while one session renders.
#[derive(Clone)]
pub(crate) struct TranscriptCtx<'a> {
    pub(crate) view: &'a SessionView,
    /// The same view as a shared handle (the list keeps it between frames).
    pub(crate) shared: Rc<SessionView>,
    pub(crate) client: Option<butler_shell_client::ShellClient>,
    /// The message carrying the running turn's live activity (`liveMessageId`).
    pub(crate) live_message: Option<&'a str>,
    /// Rows that just arrived (`enteringIds`); a queued follow-up resolving in place is
    /// `Delivered`.
    pub(crate) entering: Rc<HashMap<String, Entering>>,
    /// The worked-for time and finish time of each assistant message (`assistantFooterMetaById`).
    pub(crate) footer_meta: Rc<HashMap<String, FooterMeta>>,
    /// The message whose body is rendering.
    pub(crate) message_id: Option<&'a str>,
}

#[derive(Default)]
struct Actions {
    send: Option<Rc<dyn Fn(&str, &mut App)>>,
}

impl Global for Actions {}

/// Sends a message into the open chat (an answer's "ask" pill).
fn send_message(text: &str, cx: &mut App) {
    if let Some(send) = cx.default_global::<Actions>().send.clone() {
        send(text, cx);
    }
}

/// Opens a link of an answer or the image viewer: until the conversation browser lands (P5),
/// the system browser (`openConversationLink`).
pub(crate) fn open_link(url: &str, cx: &mut App) {
    cx.open_url(url);
}

/// Registers what sends a message into the open chat.
pub(crate) fn on_send(cx: &mut App, handler: impl Fn(&str, &mut App) + 'static) {
    cx.default_global::<Actions>().send = Some(Rc::new(handler));
}

impl<'a> TranscriptCtx<'a> {
    pub(crate) fn new(
        shared: &'a Rc<SessionView>,
        client: Option<butler_shell_client::ShellClient>,
        entering: Rc<HashMap<String, Entering>>,
        footer_meta: Rc<HashMap<String, FooterMeta>>,
    ) -> Self {
        Self {
            view: shared,
            shared: shared.clone(),
            client,
            live_message: None,
            entering,
            footer_meta,
            message_id: None,
        }
    }
}

pub(crate) struct Chat {
    view: Option<Rc<SessionView>>,
    queue: Option<Rc<SessionQueueView>>,
    /// Messages that arrived live, and when (they play the insert motion once).
    entering: HashMap<String, (Entering, Instant)>,
    /// Ids shown as queued rows (`wasQueued`): the message that replaces one resolves in place.
    queued: HashSet<String>,
    footer_meta: Rc<HashMap<String, FooterMeta>>,
    /// The open transcript's smooth scroll, for wheel events caught over a dialog.
    wheel: Rc<RefCell<Option<SmoothScroll>>>,
}

/// The id a queued record's row carries.
fn queued_key(record: &QueuedMessageRecord) -> &str {
    record.client_message_id.as_deref().unwrap_or(&record.id)
}

impl Chat {
    pub(crate) fn new() -> Self {
        Self {
            view: None,
            queue: None,
            entering: HashMap::new(),
            queued: HashSet::new(),
            footer_meta: Rc::default(),
            wheel: Rc::default(),
        }
    }

    /// Shows `view` (`None`: a new chat, or nothing open). `live` marks the messages it adds
    /// to the shown session as arrived: opening a chat or paging older does not play motion.
    pub(crate) fn set_view(&mut self, view: Option<Rc<SessionView>>, live: bool, cx: &App) {
        let same_session = match (&self.view, &view) {
            (Some(old), Some(new)) => old.session_id == new.session_id,
            _ => false,
        };
        if !same_session {
            self.entering.clear();
            self.queued.clear();
            self.queue = None;
        }
        if let (true, true, Some(old), Some(new)) = (live, same_session, &self.view, &view) {
            let known: HashSet<&str> = old.messages.iter().map(|m| m.id.as_str()).collect();
            for message in new
                .messages
                .iter()
                .filter(|m| !known.contains(m.id.as_str()))
            {
                let kind = if self.queued.contains(&message.id) {
                    Entering::Delivered
                } else {
                    Entering::Yes
                };
                self.entering
                    .insert(message.id.clone(), (kind, Instant::now()));
            }
        }
        let lang = Ds::get(cx).lang();
        self.footer_meta = Rc::new(
            view.as_ref()
                .map(|view| footer_meta::footer_meta(&view.messages, lang))
                .unwrap_or_default(),
        );
        self.view = view;
    }

    /// Shows the open session's queued follow-ups.
    pub(crate) fn set_queue(&mut self, queue: Option<Rc<SessionQueueView>>) {
        if let Some(queue) = &queue {
            self.queued.extend(
                queue
                    .queued_messages
                    .iter()
                    .map(|record| queued_key(record).to_owned()),
            );
        }
        self.queue = queue;
    }

    /// Scrolls the conversation for a wheel event caught over a dialog (same smooth scroll).
    pub(crate) fn wheel_from_overlay(
        &mut self,
        e: &gpui::ScrollWheelEvent,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let smooth = self.wheel.borrow().clone();
        if smooth.is_some_and(|smooth| smooth.wheel(e, window)) {
            cx.notify();
        }
    }
}

impl Render for Chat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(shared) = self.view.clone() else {
            return div().id("chat-list").size_full().into_any_element();
        };
        self.entering.retain(|_, (_, at)| at.elapsed() < ENTERING);
        let entering = self
            .entering
            .iter()
            .map(|(id, (kind, _))| (id.clone(), *kind))
            .collect();
        let t = TranscriptCtx::new(
            &shared,
            Jobs::client(cx),
            Rc::new(entering),
            self.footer_meta.clone(),
        );
        list::transcript(&t, self.queue.as_deref(), &self.wheel, window, cx)
    }
}
