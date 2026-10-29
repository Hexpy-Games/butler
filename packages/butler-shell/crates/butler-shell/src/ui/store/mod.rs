//! The shell's data state, without gpui: the chat list and its snapshot generation, the open
//! chat, running turns, authority requests and answers in flight, and the live cursor. The
//! shell runs the [`crate::ui::source::Source`] requests; the results come back here.
//!
//! A snapshot (connect or resync) bumps the generation: results and live events of an older
//! one are dropped, and the shown list stays until the new snapshot's first page replaces it.
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use crate::ui::source::{
    AuthorityCard, ChatId, ChatPage, ChatRef, ChatSummary, EventCursor, LiveEvent, LiveUpdate,
    Message, MessagePage, PageCursor, RequestRef, SessionId, TurnId,
};

/// A chats load in flight: its snapshot generation and the page it asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChatsLoad {
    pub(crate) epoch: u64,
    pub(crate) cursor: Option<PageCursor>,
}

/// What a live event asks of the shell.
pub(crate) enum Applied {
    /// Nothing visible beyond the store (or the event was stale or a duplicate).
    Store,
    Failed(crate::ui::source::SourceError),
    /// A message of `session` to show if that chat is open.
    Message(SessionId, Message),
    /// Events were lost: take a new snapshot.
    Resync,
    MessageDeleted(SessionId, gpui::SharedString),
}

#[derive(Default)]
pub(crate) struct Store {
    pub(crate) chats: Vec<ChatSummary>,
    pub(crate) chats_next: Option<PageCursor>,
    epoch: u64,
    loading: Option<ChatsLoad>,
    selected: Option<ChatRef>,
    running: HashMap<ChatId, TurnId>,
    authority: HashMap<SessionId, Vec<AuthorityCard>>,
    pending: HashSet<RequestRef>,
    /// The last durable event applied; live updates resume after it.
    pub(crate) cursor: Option<EventCursor>,
    message_snapshots: HashMap<SessionId, EventCursor>,
}

impl Store {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    /// A new snapshot (connect, resync): supersedes any load in flight.
    pub(crate) fn begin_snapshot(&mut self) -> ChatsLoad {
        self.epoch += 1;
        let load = ChatsLoad {
            epoch: self.epoch,
            cursor: None,
        };
        self.loading = Some(load.clone());
        load
    }

    /// The next page of the current snapshot, unless one is loading or none is left.
    pub(crate) fn begin_more(&mut self) -> Option<ChatsLoad> {
        if self.loading.is_some() {
            return None;
        }
        let load = ChatsLoad {
            epoch: self.epoch,
            cursor: Some(self.chats_next.clone()?),
        };
        self.loading = Some(load.clone());
        Some(load)
    }

    /// A chats page arrived. A snapshot's first page replaces the list and returns the event
    /// cursor live updates start after; a stale page is dropped.
    pub(crate) fn chats_loaded(&mut self, load: &ChatsLoad, page: ChatPage) -> Option<EventCursor> {
        if self.loading.as_ref() != Some(load) {
            return None;
        }
        self.loading = None;
        self.chats_next = page.next;
        if load.cursor.is_some() {
            self.chats
                .extend(page.chats.into_iter().filter(|c| !c.archived));
            return None;
        }
        self.chats = page.chats.into_iter().filter(|c| !c.archived).collect();
        self.running = (self.chats.iter())
            .filter(|c| c.running)
            .filter_map(|c| {
                self.running
                    .get(&c.chat.chat)
                    .map(|t| (c.chat.chat.clone(), t.clone()))
            })
            .collect();
        self.cursor = Some(page.events);
        Some(page.events)
    }

    pub(crate) fn chats_failed(&mut self, load: &ChatsLoad) {
        if self.loading.as_ref() == Some(load) {
            self.loading = None;
        }
    }

    pub(crate) fn selected(&self) -> Option<&ChatRef> {
        self.selected.as_ref()
    }

    pub(crate) fn open(&mut self, chat: Option<ChatRef>) {
        self.selected = chat;
    }

    /// A missing chat loses all its state; another request failure leaves it intact.
    pub(crate) fn chat_failed(
        &mut self,
        chat: &ChatRef,
        error: &crate::ui::source::SourceError,
    ) -> bool {
        if !matches!(error, crate::ui::source::SourceError::Missing) {
            return false;
        }
        self.chats.retain(|row| row.chat != *chat);
        self.running.remove(&chat.chat);
        if let Some(cards) = self.authority.remove(&chat.session) {
            for card in cards {
                self.pending.remove(&card.request);
            }
        }
        self.message_snapshots.remove(&chat.session);
        if self.selected.as_ref() != Some(chat) {
            return false;
        }
        self.selected = None;
        true
    }

    pub(crate) fn summary(&self, chat: &ChatRef) -> Option<&ChatSummary> {
        self.chats.iter().find(|c| &c.chat == chat)
    }

    /// A message window arrived; true when its chat is still open. Its running turn is taken.
    pub(crate) fn messages_loaded(&mut self, chat: &ChatRef, page: &MessagePage) -> bool {
        self.message_snapshots
            .insert(chat.session.clone(), page.events);
        self.set_running(&chat.chat, page.running.clone());
        self.selected.as_ref() == Some(chat)
    }

    fn set_running(&mut self, chat: &ChatId, running: Option<TurnId>) {
        if let Some(row) = self.chats.iter_mut().find(|c| &c.chat.chat == chat) {
            row.running = running.is_some();
        }
        match running {
            Some(turn) => self.running.insert(chat.clone(), turn),
            None => self.running.remove(chat),
        };
    }

    pub(crate) fn turn_started(&mut self, chat: &ChatId, turn: TurnId) {
        self.set_running(chat, Some(turn));
    }

    /// The open chat's running turn.
    pub(crate) fn running(&self) -> Option<&TurnId> {
        self.running.get(&self.selected.as_ref()?.chat)
    }

    pub(crate) fn authority_loaded(&mut self, session: SessionId, cards: Vec<AuthorityCard>) {
        self.authority.insert(session, cards);
    }

    /// The open chat's first outstanding authority request.
    pub(crate) fn approval(&self) -> Option<&AuthorityCard> {
        self.authority
            .get(&self.selected.as_ref()?.session)?
            .first()
    }

    pub(crate) fn is_pending(&self, request: &RequestRef) -> bool {
        self.pending.contains(request)
    }

    /// An answer is on its way; false when one already is.
    pub(crate) fn begin_answer(&mut self, request: &RequestRef) -> bool {
        self.pending.insert(request.clone())
    }

    /// The agent took the answer: the card goes.
    pub(crate) fn answer_done(&mut self, session: &SessionId, request: &RequestRef) {
        self.pending.remove(request);
        if let Some(cards) = self.authority.get_mut(session) {
            cards.retain(|c| &c.request != request);
        }
    }

    /// The answer failed: the card stays, ready to answer again.
    pub(crate) fn answer_failed(&mut self, request: &RequestRef) {
        self.pending.remove(request);
    }

    /// Applies a live event from the stream of snapshot `epoch`; stale streams and replayed
    /// cursors are ignored.
    pub(crate) fn apply(&mut self, epoch: u64, event: LiveEvent) -> Applied {
        if epoch != self.epoch {
            return Applied::Store;
        }
        if let Some(cursor) = event.cursor {
            if self.cursor.is_some_and(|last| cursor <= last) {
                return Applied::Store;
            }
            self.cursor = Some(cursor);
        }
        match event.update {
            LiveUpdate::Failed(error) => return Applied::Failed(error),
            LiveUpdate::Message { session, message } => {
                if event.cursor.is_some_and(|c| {
                    self.message_snapshots
                        .get(&session)
                        .is_some_and(|snapshot| c <= *snapshot)
                }) {
                    return Applied::Store;
                }
                return Applied::Message(session, message);
            }
            LiveUpdate::MessageDeleted { session, id } => {
                return Applied::MessageDeleted(session, id);
            }
            LiveUpdate::Turn { chat, running } => self.set_running(&chat, running),
            LiveUpdate::Authority { session, cards } => self.authority_loaded(session, cards),
            LiveUpdate::Chat(summary) => {
                self.chats.retain(|c| c.chat != summary.chat);
                if !summary.archived {
                    let key = |c: &ChatSummary| {
                        (c.pinned, c.updated_at, c.created_at, c.chat.chat.0.clone())
                    };
                    let at = self.chats.partition_point(|c| key(c) > key(&summary));
                    self.chats.insert(at, summary);
                }
            }
            LiveUpdate::Resync => return Applied::Resync,
        }
        Applied::Store
    }

    /// The agent went away: nothing it owns stays actionable.
    pub(crate) fn lost(&mut self) {
        self.epoch += 1;
        self.loading = None;
        self.running.clear();
        self.authority.clear();
        self.pending.clear();
        self.cursor = None;
        self.message_snapshots.clear();
    }
}
