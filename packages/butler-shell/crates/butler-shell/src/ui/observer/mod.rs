//! The session observer dialog (`layout/SessionObserverDialog.tsx`, `Header`, `Body`,
//! `Controls`, `Timeline`): another session's view over the current one. The shell keeps its
//! back history (`store.ts:1116-1133`).
mod controls;
mod copy;

use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::message_row::{MessageRow, Role};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{
    Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Layout, MaxHeight,
};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement as _, ParentElement as _, SharedString, Styled as _, Subscription, Window, div,
};

use self::copy::{Words, words};
use crate::ui::chat::Chat;
use crate::ui::manage::{ManageLive, Topic};
use crate::ui::source::fetch::{Flight, fetch_if};
use crate::ui::source::wire::{MessageRecordRole, SessionView, SessionViewStatus};
use crate::ui::widgets::anchor;

/// The most messages one window carries (the gateway's `session-view` maximum).
const WINDOW_LIMIT: u32 = 200;

/// What the dialog asks the shell: back to the session observed before, or close.
pub(crate) enum ObserverEvent {
    Back,
    Close,
}

/// `SessionObserverDialog`
pub(crate) struct SessionObserver {
    session: SharedString,
    live: Entity<ManageLive>,
    /// The session topic's revision as of the last read (`useSessionViewSubscription`).
    revision: u64,
    view: Option<Rc<SessionView>>,
    /// The observed transcript: the conversation's own list over the observed view.
    chat: Entity<Chat>,
    flight: Flight,
    /// `observerHistory.length > 0`, set by the shell.
    can_go_back: bool,
    /// `activeChatId`: the conversation a stop or resume is made for, set by the shell.
    parent: Option<SharedString>,
    cancelling: bool,
    resuming: bool,
    _live: Subscription,
}

impl EventEmitter<ObserverEvent> for SessionObserver {}

impl SessionObserver {
    pub(crate) fn new(
        session: SharedString,
        _turn: Option<&SharedString>,
        live: Entity<ManageLive>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let chat = cx.new(|_| {
            let mut chat = Chat::new();
            chat.set_new_chat(false);
            chat
        });
        let follow = cx.observe(&live, |this, live, cx| {
            let revision = live
                .read(cx)
                .revision(&Topic::Session(this.session.clone()));
            if revision != this.revision {
                this.revision = revision;
                this.refresh(cx);
            }
        });
        let revision = live.read(cx).revision(&Topic::Session(session.clone()));
        let mut observer = Self {
            session,
            live,
            revision,
            view: None,
            chat,
            flight: Flight::default(),
            can_go_back: false,
            parent: None,
            cancelling: false,
            resuming: false,
            _live: follow,
        };
        // CARVE-OUT(G-ds): the target turn is expanded and scrolled to in React
        // (`data-turn-id`, smooth); the transcript list has no scroll-to-turn yet.
        // ANIM-MIGRATE(smooth scroll to the target turn)
        observer.refresh(cx);
        observer
    }

    /// Observes another session (or another turn of it).
    pub(crate) fn show(
        &mut self,
        session: SharedString,
        _turn: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        if self.session != session {
            self.revision = self
                .live
                .read(cx)
                .revision(&Topic::Session(session.clone()));
            self.session = session;
            self.view = None;
            self.sync_chat(cx);
            self.refresh(cx);
        }
        cx.notify();
    }

    /// Whether the shell holds a session to go back to (`observerHistory.length > 0`).
    pub(crate) fn set_can_go_back(&mut self, can: bool, cx: &mut Context<Self>) {
        if self.can_go_back != can {
            self.can_go_back = can;
            cx.notify();
        }
    }

    /// `activeChatId`, for the stop and resume calls.
    pub(crate) fn set_parent(&mut self, parent: Option<SharedString>) {
        self.parent = parent;
    }

    /// `refreshSessionObserver`: one read at a time; a change during a read runs one more.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.flight.begin() {
            self.read(cx);
        }
    }

    /// GET /session-view for the observed session.
    fn read(&mut self, cx: &mut Context<Self>) {
        let (asked, session) = (self.session.clone(), self.session.to_string());
        fetch_if(
            cx,
            move |client| async move { client.message_window(&session, None, WINDOW_LIMIT).await },
            move |this: &mut Self, result: Result<SessionView, Error>, cx| {
                let again = this.flight.end();
                let mut changed = false;
                if this.session == asked
                    && let Ok(view) = result
                    && this.view.as_deref() != Some(&view)
                {
                    this.view = Some(Rc::new(view));
                    this.sync_chat(cx);
                    changed = true;
                }
                if again {
                    this.read(cx);
                }
                changed
            },
        );
    }

    /// Hands the transcript the observed view: a steward's own prompt is hidden
    /// (`message.role !== "user"` when it has a relation), and nothing pages older.
    fn sync_chat(&self, cx: &mut Context<Self>) {
        let shown = self.view.as_deref().map(|view| {
            let mut view = view.clone();
            if view.relation.is_some() {
                view.messages
                    .retain(|message| message.role != MessageRecordRole::User);
            }
            view.message_window.previous_cursor = None;
            view.message_window.previous_cursor_token = None;
            Rc::new(view)
        });
        self.chat
            .update(cx, |chat, cx| chat.set_view(shown, true, cx));
    }

    fn header(&self, copy: &Words, cx: &Context<Self>) -> DialogHeader {
        let title: SharedString = self
            .view
            .as_ref()
            .and_then(|view| view.relation.as_ref())
            .map_or_else(|| self.session.clone(), |r| r.safe_title.clone().into());
        let mut row = Stack::row().cross(Cross::Center).gap(Space::Xs);
        if self.can_go_back {
            let me = cx.entity();
            row = row.child(
                IconButton::new("steward-observer-back", copy.back)
                    .glyph(Icon::ArrowLeft)
                    .on_click(move |_, _, cx| {
                        me.update(cx, |_, cx| cx.emit(ObserverEvent::Back));
                    }),
            );
        }
        DialogHeader::new()
            .child(row.child(DialogTitle::new(title)))
            .child(DialogDescription::new(copy.activity))
    }

    /// `SessionObserverBody`: the transcript, or what an empty session says.
    fn body(&self, copy: &Words) -> AnyElement {
        let Some(view) = self.view.as_deref() else {
            return Typo::caption(copy.pending).into_any_element();
        };
        let waiting = view.waiting_for_children == Some(true);
        if view.messages.is_empty() && view.active_turn.is_none() && !waiting {
            let label = match view.status {
                SessionViewStatus::Delivered => copy.delivered,
                SessionViewStatus::Failed => copy.failed,
                SessionViewStatus::Cancelled => copy.cancelled,
                _ => copy.pending,
            };
            return Typo::caption(label).into_any_element();
        }
        let mut body = Stack::new()
            .gap(Space::Lg)
            .child(div().flex_1().min_h_0().child(self.chat.clone()));
        if waiting && view.active_turn.is_none() {
            body = body.child(
                MessageRow::new("steward-observer-worker-wait", Role::Assistant)
                    .activity()
                    .child(Typo::body(copy.waiting)),
            );
        }
        body.into_any_element()
    }

    /// The dialog, open while the shell holds this observer.
    pub(crate) fn render_dialog(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        let dialog = Dialog::new("steward-observer", window, cx)
            .open(true)
            .on_open_change(move |open, _, cx| {
                if !open {
                    me.update(cx, |_, cx| cx.emit(ObserverEvent::Close));
                }
            });
        let mut content = DialogContent::new()
            .layout(Layout::ScrollBody)
            .max_height(MaxHeight::ThreeFifths)
            .full_height()
            .header(self.header(copy, cx))
            .child(anchor(
                div()
                    .id("steward-observer-transcript")
                    .flex_1()
                    .min_h_0()
                    .child(self.body(copy)),
                "steward-observer-transcript",
            ));
        if let Some(footer) = self
            .view
            .as_deref()
            .and_then(|view| self.controls(view, cx))
        {
            content = content.footer(footer);
        }
        anchor(
            div().child(dialog.content(content, window, cx)),
            "steward-observer-dialog",
        )
        .into_any_element()
    }
}
