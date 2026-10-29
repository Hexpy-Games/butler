//! Runs the [`Source`] requests the shell needs and hands the results to the [`Store`]. Each
//! snapshot (connect, resync) gets its own live stream, started after the snapshot's event
//! cursor; a stream or result of an older snapshot is dropped.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use futures::StreamExt as _;
use gpui::{Context, SharedString, Window};

use super::Shell;
use crate::ui::chat::LoadOlder;
use crate::ui::source::{
    ChatRef, ClientMessageId, Decision, EventCursor, Fetch, RequestRef, SourceError,
};
use crate::ui::store::{Applied, ChatsLoad};

/// A message id unique to this process run (time plus a counter).
fn client_message_id() -> ClientMessageId {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    ClientMessageId(format!(
        "shell-{nanos:x}-{}",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

impl Shell {
    /// Runs `fetch` and hands its result to `done` on the UI thread.
    fn run<T: 'static>(
        fetch: Fetch<T>,
        cx: &mut Context<Self>,
        done: impl FnOnce(&mut Self, Result<T, SourceError>, &mut Context<Self>) + 'static,
    ) {
        cx.spawn(async move |this, cx| {
            let result = fetch.await;
            let _ = this.update(cx, |this, cx| done(this, result, cx));
        })
        .detach();
    }

    /// A fresh snapshot: the first page of chats, then live updates after its cursor.
    pub(super) fn connect(&mut self, cx: &mut Context<Self>) {
        if self.source.is_some() {
            let load = self.store.begin_snapshot();
            self.load_chats(load, cx);
        }
    }

    fn load_chats(&mut self, load: ChatsLoad, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        Self::run(
            source.chats(load.cursor.clone()),
            cx,
            move |this, result, cx| {
                match result {
                    Ok(page) => {
                        if let Some(after) = this.store.chats_loaded(&load, page) {
                            this.subscribe(load.epoch, after, cx);
                            this.reload_open_chat(cx);
                        }
                    }
                    Err(e) => {
                        this.store.chats_failed(&load);
                        this.failed(&e, this.theme.strings.load_failed, cx);
                    }
                }
                cx.notify();
            },
        );
    }

    fn subscribe(&mut self, epoch: u64, after: EventCursor, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let mut live = source.live(after);
        cx.spawn(async move |this, cx| {
            while let Some(event) = live.next().await {
                let current = this.update(cx, |this, cx| {
                    if this.store.epoch() != epoch {
                        return false;
                    }
                    this.apply(epoch, event, cx);
                    true
                });
                if !matches!(current, Ok(true)) {
                    return;
                }
            }
            let _ = this.update(cx, |this, cx| {
                if this.store.epoch() == epoch {
                    this.lost(cx);
                }
            });
        })
        .detach();
    }

    fn apply(&mut self, epoch: u64, event: crate::ui::source::LiveEvent, cx: &mut Context<Self>) {
        match self.store.apply(epoch, event) {
            Applied::Store => {}
            Applied::Message(session, message) => self.chat.update(cx, |c, cx| {
                c.upsert(&session, message);
                cx.notify();
            }),
            Applied::Resync => self.connect(cx),
        }
        self.sync_composer(cx);
        cx.notify();
    }

    /// The next page of chats, when the sidebar wants more rows than are loaded.
    pub(crate) fn load_more_chats(&mut self, cx: &mut Context<Self>) {
        if let Some(load) = self.store.begin_more() {
            self.load_chats(load, cx);
        }
    }

    /// Opens `chat` from its latest messages (`None`: a new chat).
    pub(crate) fn open_chat(
        &mut self,
        chat: Option<ChatRef>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source.is_none() {
            return;
        }
        // A dialog belongs to the open chat's request.
        self.close_dialog(cx);
        let new_chat = chat.is_none();
        self.chat.update(cx, |c, _| c.show(chat.clone(), None));
        self.store.open(chat);
        self.composer.update(cx, |c, cx| {
            c.set_new_chat(new_chat, cx);
            if new_chat {
                c.engage(window, cx);
            } else {
                c.fold();
            }
        });
        self.reload_open_chat(cx);
        self.sync_composer(cx);
        cx.notify();
    }

    /// Reloads the open chat's latest window and its authority requests.
    fn reload_open_chat(&mut self, cx: &mut Context<Self>) {
        let (Some(chat), Some(source)) = (self.store.selected().cloned(), self.source.clone())
        else {
            return;
        };
        let shown = chat.clone();
        Self::run(
            source.messages(&chat.session, None),
            cx,
            move |this, result, cx| match result {
                Ok(page) => {
                    if this.store.messages_loaded(&shown, &page) {
                        this.chat.update(cx, |c, cx| {
                            c.show(Some(shown), Some(page));
                            cx.notify();
                        });
                    }
                    this.sync_composer(cx);
                }
                Err(e) => this.failed(&e, this.theme.strings.load_failed, cx),
            },
        );
        self.reload_authority(&chat, cx);
    }

    fn reload_authority(&mut self, chat: &ChatRef, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let session = chat.session.clone();
        Self::run(
            source.authority(&chat.session),
            cx,
            move |this, result, cx| {
                if let Ok(cards) = result {
                    this.store.authority_loaded(session, cards);
                    this.sync_composer(cx);
                }
            },
        );
    }

    pub(super) fn load_older(&mut self, e: &LoadOlder, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let chat = e.0.clone();
        Self::run(
            source.messages(&chat.session, Some(e.1.clone())),
            cx,
            move |this, result, cx| match result {
                Ok(page) => this.chat.update(cx, |c, cx| {
                    c.prepend(&chat, page);
                    cx.notify();
                }),
                Err(e) => this.failed(&e, this.theme.strings.load_failed, cx),
            },
        );
    }

    /// The agent went away: back to the disconnected state.
    fn lost(&mut self, cx: &mut Context<Self>) {
        self.source = None;
        self.store.lost();
        self.sync_composer(cx);
        cx.notify();
    }

    /// The composer follows the open chat: the agent, a running turn and its first request.
    pub(super) fn sync_composer(&mut self, cx: &mut Context<Self>) {
        let streaming = self.store.running().is_some();
        let approval = self.store.approval().cloned();
        let pending = approval
            .as_ref()
            .is_some_and(|c| self.store.is_pending(&c.request));
        let disabled = self.disconnected();
        let context = self.source.as_ref().map(|s| s.composer());
        self.composer.update(cx, |c, cx| {
            c.streaming = streaming;
            c.approval = approval.map(|card| (card, pending));
            if disabled.is_some() {
                c.fold();
            }
            c.disabled = disabled;
            c.context = context;
            cx.notify();
        });
    }

    pub(super) fn send(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let id = client_message_id();
        if let Some(chat) = self.store.selected().cloned() {
            return self.send_to(chat, id, text, cx);
        }
        // A new chat: create it, open it, then send into it.
        Self::run(
            source.create_chat(),
            cx,
            move |this, result, cx| match result {
                Ok(chat) => {
                    this.store.open(Some(chat.clone()));
                    this.chat
                        .update(cx, |c, _| c.show(Some(chat.clone()), None));
                    this.send_to(chat, id, text, cx);
                }
                Err(e) => this.failed(&e, this.theme.strings.send_failed, cx),
            },
        );
    }

    fn send_to(
        &mut self,
        chat: ChatRef,
        id: ClientMessageId,
        text: String,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = self.source.clone() else {
            return;
        };
        Self::run(
            source.send(&chat.chat, id, text),
            cx,
            move |this, result, cx| match result {
                Ok(sent) => {
                    this.store.turn_started(&chat.chat, sent.turn);
                    this.sync_composer(cx);
                }
                Err(e) => this.failed(&e, this.theme.strings.send_failed, cx),
            },
        );
    }

    pub(super) fn stop(&mut self, cx: &mut Context<Self>) {
        let (Some(turn), Some(source)) = (self.store.running().cloned(), self.source.clone())
        else {
            return;
        };
        Self::run(source.cancel(&turn), cx, |this, result, cx| {
            if let Err(e) = result {
                this.failed(&e, this.theme.strings.stop_failed, cx);
            }
        });
    }

    /// Answers the open chat's request. The card shows the answer as pending and stays until
    /// the agent takes it; on failure it is ready again and the list is re-read.
    pub(super) fn answer(
        &mut self,
        request: &RequestRef,
        decision: Decision,
        cx: &mut Context<Self>,
    ) {
        let (Some(chat), Some(source)) = (self.store.selected().cloned(), self.source.clone())
        else {
            return;
        };
        if !self.store.begin_answer(request) {
            return;
        }
        self.sync_composer(cx);
        let request = request.clone();
        let fetch = source.answer(&chat.session, &request, decision);
        Self::run(fetch, cx, move |this, result, cx| {
            match result {
                Ok(()) => this.store.answer_done(&chat.session, &request),
                Err(e) => {
                    this.store.answer_failed(&request);
                    this.reload_authority(&chat, cx);
                    this.failed(&e, this.theme.strings.decision_failed, cx);
                }
            }
            this.sync_composer(cx);
        });
    }

    /// A failed request: a brief toast, or the disconnected state when the agent is gone.
    fn failed(&mut self, error: &SourceError, toast: &'static str, cx: &mut Context<Self>) {
        match error {
            SourceError::Disconnected => self.lost(cx),
            SourceError::Refused(_) => {
                self.toast = Some((SharedString::from(toast), Instant::now()));
            }
        }
        cx.notify();
    }
}
