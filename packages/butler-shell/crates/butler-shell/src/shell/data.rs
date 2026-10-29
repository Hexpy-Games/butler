//! The shell's side of the data boundary: it asks the [`Source`] for pages, applies live
//! updates, and sends what the owner does. Results land on the UI thread; a result for a chat
//! that is no longer open is dropped.
use std::time::Instant;

use futures::StreamExt as _;
use gpui::{Context, SharedString, Window};

use super::{NOT_RUNNING, Shell};
use crate::chat::LoadOlder;
use crate::source::{ChatId, Decision, Fetch, LiveUpdate, SourceError};

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

    /// First page of chats and the live stream, when an agent is attached.
    pub(super) fn connect(&mut self, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        self.chats.clear();
        self.chats_next = None;
        self.load_chats(None, cx);
        let mut live = source.live();
        cx.spawn(async move |this, cx| {
            while let Some(update) = live.next().await {
                if this.update(cx, |this, cx| this.apply(update, cx)).is_err() {
                    return;
                }
            }
            let _ = this.update(cx, super::Shell::lost);
        })
        .detach();
    }

    fn load_chats(&mut self, cursor: Option<crate::source::PageCursor>, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        if self.loading_chats {
            return;
        }
        self.loading_chats = true;
        Self::run(source.chats(cursor), cx, |this, result, cx| {
            this.loading_chats = false;
            match result {
                Ok(page) => {
                    this.chats.extend(page.chats);
                    this.chats_next = page.next;
                }
                Err(e) => this.failed(&e, "목록을 불러오지 못했습니다", cx),
            }
            cx.notify();
        });
    }

    /// The next page of chats, when the sidebar wants more rows than are loaded.
    pub(crate) fn load_more_chats(&mut self, cx: &mut Context<Self>) {
        if let Some(next) = self.chats_next.clone() {
            self.load_chats(Some(next), cx);
        }
    }

    /// Opens `chat` (`None`: a new chat) from its latest messages.
    pub(crate) fn open_chat(
        &mut self,
        chat: Option<ChatId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.source.is_none() {
            return;
        }
        self.selected = chat.clone();
        self.chat.update(cx, |c, _| c.show(chat.clone(), None));
        let new_chat = chat.is_none();
        self.composer.update(cx, |c, cx| {
            c.set_new_chat(new_chat, cx);
            if new_chat {
                c.engage(window, cx);
            } else {
                c.fold();
            }
        });
        self.sync_composer(cx);
        if let (Some(id), Some(source)) = (chat, self.source.clone()) {
            let shown = id.clone();
            Self::run(
                source.messages(&id, None),
                cx,
                move |this, result, cx| match result {
                    Ok(page) if this.selected.as_ref() == Some(&shown) => {
                        match page.running.clone() {
                            Some(turn) => this.running.insert(shown.clone(), turn),
                            None => this.running.remove(&shown),
                        };
                        this.sync_composer(cx);
                        this.chat.update(cx, |c, cx| {
                            c.show(Some(shown), Some(page));
                            cx.notify();
                        });
                    }
                    Ok(_) => {}
                    Err(e) => this.failed(&e, "대화를 불러오지 못했습니다", cx),
                },
            );
            Self::run(source.authority(&id), cx, move |this, result, cx| {
                if let Ok(cards) = result {
                    this.authority.insert(id, cards);
                    this.sync_composer(cx);
                }
            });
        }
        cx.notify();
    }

    pub(super) fn load_older(&mut self, e: &LoadOlder, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let chat = e.0.clone();
        Self::run(
            source.messages(&e.0, Some(e.1.clone())),
            cx,
            move |this, result, cx| match result {
                Ok(page) => this.chat.update(cx, |c, cx| {
                    c.prepend(&chat, page);
                    cx.notify();
                }),
                Err(e) => this.failed(&e, "대화를 불러오지 못했습니다", cx),
            },
        );
    }

    fn apply(&mut self, update: LiveUpdate, cx: &mut Context<Self>) {
        match update {
            LiveUpdate::Message { chat, message } => self.chat.update(cx, |c, cx| {
                c.upsert(&chat, message);
                cx.notify();
            }),
            LiveUpdate::Turn { chat, running } => {
                if let Some(row) = self.chats.iter_mut().find(|c| c.id == chat) {
                    row.running = running.is_some();
                }
                match running {
                    Some(turn) => self.running.insert(chat, turn),
                    None => self.running.remove(&chat),
                };
            }
            LiveUpdate::Authority { chat, cards } => {
                self.authority.insert(chat, cards);
            }
            LiveUpdate::Chat(summary) => match self.chats.iter_mut().find(|c| c.id == summary.id) {
                Some(row) => *row = summary,
                None => self.chats.insert(0, summary),
            },
            LiveUpdate::Resync => self.resync(cx),
        }
        self.sync_composer(cx);
        cx.notify();
    }

    /// Events were lost: reload the chat list and the open chat.
    fn resync(&mut self, cx: &mut Context<Self>) {
        self.chats.clear();
        self.chats_next = None;
        self.load_chats(None, cx);
        let (Some(chat), Some(source)) = (self.selected.clone(), self.source.clone()) else {
            return;
        };
        Self::run(source.messages(&chat, None), cx, move |this, result, cx| {
            if let Ok(page) = result
                && this.selected.as_ref() == Some(&chat)
            {
                this.chat.update(cx, |c, cx| {
                    c.show(Some(chat), Some(page));
                    cx.notify();
                });
            }
        });
    }

    /// The live stream ended: the agent stopped or the connection dropped.
    fn lost(&mut self, cx: &mut Context<Self>) {
        self.source = None;
        self.running.clear();
        self.authority.clear();
        self.composer.update(cx, |c, cx| {
            c.disabled = Some(NOT_RUNNING.into());
            c.context = None;
            c.fold();
            cx.notify();
        });
        self.sync_composer(cx);
        cx.notify();
    }

    /// The composer follows the open chat: a running turn and its first authority request.
    fn sync_composer(&mut self, cx: &mut Context<Self>) {
        let chat = self.selected.as_ref();
        let streaming = chat.is_some_and(|c| self.running.contains_key(c));
        let approval = chat
            .and_then(|c| self.authority.get(c))
            .and_then(|cards| cards.first())
            .cloned();
        self.composer.update(cx, |c, cx| {
            c.streaming = streaming;
            c.approval = approval;
            cx.notify();
        });
    }

    pub(super) fn send(&mut self, text: String, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        Self::run(
            source.send(self.selected.clone(), text),
            cx,
            |this, result, cx| match result {
                Ok(sent) => {
                    if this.selected.is_none() {
                        this.selected = Some(sent.chat.clone());
                        this.chat
                            .update(cx, |c, _| c.show(Some(sent.chat.clone()), None));
                    }
                    this.running.insert(sent.chat, sent.turn);
                    this.sync_composer(cx);
                }
                Err(e) => this.failed(&e, "보내지 못했습니다", cx),
            },
        );
    }

    pub(super) fn stop(&mut self, cx: &mut Context<Self>) {
        let turn = self
            .selected
            .as_ref()
            .and_then(|c| self.running.get(c))
            .cloned();
        let (Some(turn), Some(source)) = (turn, self.source.clone()) else {
            return;
        };
        Self::run(source.cancel(turn), cx, |this, result, cx| {
            if let Err(e) = result {
                this.failed(&e, "중지하지 못했습니다", cx);
            }
        });
    }

    pub(super) fn answer(
        &mut self,
        request: &SharedString,
        decision: Decision,
        cx: &mut Context<Self>,
    ) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let fetch = source.answer(request.to_string(), decision);
        if let Some(cards) = self
            .selected
            .as_ref()
            .and_then(|c| self.authority.get_mut(c))
        {
            cards.retain(|card| &card.request != request);
        }
        self.sync_composer(cx);
        Self::run(fetch, cx, |this, result, cx| {
            if let Err(e) = result {
                this.failed(&e, "응답하지 못했습니다", cx);
            }
        });
    }

    /// A failed request: a brief toast, or the disconnected state when the agent is gone.
    fn failed(&mut self, error: &SourceError, toast: &'static str, cx: &mut Context<Self>) {
        match error {
            SourceError::Disconnected => self.lost(cx),
            SourceError::Refused(_) => self.toast = Some((toast.into(), Instant::now())),
        }
        cx.notify();
    }
}
