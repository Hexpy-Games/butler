//! The session observer dialog (`layout/SessionObserverDialog.tsx`, `Header`, `Body`,
//! `Controls`, `Timeline`): another session's view over the current one. The shell keeps its
//! back history (`store.ts:1116-1133`).
mod body;
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
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::{
    AnyElement, Context, Entity, EventEmitter, IntoElement as _, ParentElement as _, SharedString,
    Styled as _, Subscription, Window, div,
};

use self::body::{Entry, entries};
use self::copy::{Words, words};
use crate::ui::chat::activity::status::StatusLineView;
use crate::ui::manage::{ManageLive, Topic};
use crate::ui::source::fetch::{Flight, fetch_if};
use crate::ui::source::wire::{SessionView, SessionViewStatus};
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
    /// The rows the body shows of `view`, in order.
    entries: Vec<Entry>,
    /// The running turn's live status line.
    status_line: Option<Entity<StatusLineView>>,
    /// The turn the dialog opened for: its activity opens (`observerTargetTurnId`).
    target: Option<SharedString>,
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
        turn: Option<&SharedString>,
        live: Entity<ManageLive>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
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
            entries: Vec::new(),
            status_line: None,
            target: turn.cloned(),
            flight: Flight::default(),
            can_go_back: false,
            parent: None,
            cancelling: false,
            resuming: false,
            _live: follow,
        };
        // CARVE-OUT(G-ds): React also scrolls the target turn to the top (smooth); the DS
        // ScrollArea takes a handle but the dialog does not track its rows' offsets yet.
        // ANIM-MIGRATE(smooth scroll to the target turn)
        observer.refresh(cx);
        observer
    }

    /// Observes another session (or another turn of it).
    pub(crate) fn show(
        &mut self,
        session: SharedString,
        turn: Option<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.target = turn;
        if self.session != session {
            self.revision = self
                .live
                .read(cx)
                .revision(&Topic::Session(session.clone()));
            self.session = session;
            self.view = None;
            self.sync(cx);
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
                    this.sync(cx);
                    changed = true;
                }
                if again {
                    this.read(cx);
                }
                changed
            },
        );
    }

    /// Builds the body's rows from the observed view (`SessionObserverTimeline`).
    fn sync(&mut self, cx: &mut Context<Self>) {
        let lang = Ds::get(cx).lang();
        self.entries = self
            .view
            .as_deref()
            .map(|view| entries(view, lang))
            .unwrap_or_default();
        match self.view.clone() {
            Some(view) => StatusLineView::sync(&mut self.status_line, &view, cx),
            None => self.status_line = None,
        }
        cx.notify();
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

    /// `SessionObserverBody`: the rows, or what an empty session says.
    fn body(&mut self, copy: &Words, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(view) = self.view.clone() else {
            return Typo::caption(copy.pending).into_any_element();
        };
        let waiting = view.waiting_for_children == Some(true);
        if self.entries.is_empty() && view.active_turn.is_none() && !waiting {
            let label = match view.status {
                SessionViewStatus::Delivered => copy.delivered,
                SessionViewStatus::Failed => copy.failed,
                SessionViewStatus::Cancelled => copy.cancelled,
                _ => copy.pending,
            };
            return Typo::caption(label).into_any_element();
        }
        let mut body = self.transcript(&view, window, cx);
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
        let body = self.body(copy, window, cx);
        let mut content = DialogContent::new()
            .layout(Layout::ScrollBody)
            .max_height(MaxHeight::ThreeFifths)
            .header(self.header(copy, cx))
            .child(
                ScrollArea::new("steward-observer-scroll")
                    .fill()
                    .child(anchor(
                        div().flex().flex_col().w_full().child(body),
                        "steward-observer-transcript",
                    )),
            );
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
