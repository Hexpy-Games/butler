//! The shell's data state, without gpui: the chat list and its snapshot generation, the open
//! chat, running turns, authority requests, and the live cursor. The
//! shell runs the [`crate::ui::source::Source`] requests; the results come back here.
//!
//! A snapshot (connect or resync) bumps the generation: results and live events of an older
//! one are dropped, and the shown list stays until the new snapshot's first page replaces it.
pub(crate) mod navigation;

#[cfg(test)]
mod tests;

pub(crate) mod drafts;
pub(crate) mod messages;
pub(crate) mod progress;
pub(crate) mod task_graph;

use std::collections::HashMap;

use crate::ui::source::wire::{AppEventEnvelope, SessionView, TurnProgressSnapshot};
use crate::ui::source::{
    AuthorityCard, ChatId, ChatPage, ChatRef, ChatSummary, EventCursor, LiveEvent, LiveUpdate,
    RequestRef, SessionId, TurnId,
};

/// The chat snapshot generation in flight.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChatsLoad {
    pub(crate) epoch: u64,
}

/// What a live event asks of the shell.
pub(crate) enum Applied {
    /// Nothing visible beyond the store (or the event was stale or a duplicate).
    Store,
    Failed(crate::ui::source::SourceError),
    /// The open chat's messages or turn progress changed: show its view again.
    Transcript,
    /// Events were lost: take a new snapshot.
    Resync,
    /// The open chat's authority requests changed: read its view again.
    Refresh,
}

#[derive(Default)]
pub(crate) struct Store {
    pub(crate) chats: Vec<ChatSummary>,
    pub(crate) navigation: navigation::NavigationModel,
    epoch: u64,
    loading: Option<ChatsLoad>,
    selected: Option<ChatRef>,
    running: HashMap<ChatId, TurnId>,
    /// Each session's outstanding authority requests, as the live refresh last read them.
    authority: HashMap<SessionId, Vec<RequestRef>>,
    /// The last durable event applied; live updates resume after it.
    pub(crate) cursor: Option<EventCursor>,
    message_snapshots: HashMap<SessionId, EventCursor>,
    /// The open session's view (`messageCache`), paged older on demand and patched by events.
    pub(crate) messages: messages::MessageCache,
    /// The open session's turn progress (`turnProgress`).
    pub(crate) progress: progress::TurnProgress,
}

impl Store {
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch
    }

    /// A new snapshot (connect, resync): supersedes any load in flight.
    pub(crate) fn begin_snapshot(&mut self) -> ChatsLoad {
        self.epoch += 1;
        let load = ChatsLoad { epoch: self.epoch };
        self.loading = Some(load.clone());
        load
    }

    /// A chats page arrived. A snapshot's first page replaces the list and returns the event
    /// cursor live updates start after; a stale page is dropped.
    pub(crate) fn chats_loaded(&mut self, load: &ChatsLoad, page: ChatPage) -> Option<EventCursor> {
        if self.loading.as_ref() != Some(load) {
            return None;
        }
        self.loading = None;
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
        if self.selected != chat {
            self.messages = messages::MessageCache::default();
            self.progress = progress::TurnProgress::default();
        }
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
        self.authority.remove(&chat.session);
        self.message_snapshots.remove(&chat.session);
        if self.selected.as_ref() != Some(chat) {
            return false;
        }
        self.open(None);
        true
    }

    pub(crate) fn summary(&self, chat: &ChatRef) -> Option<&ChatSummary> {
        self.chats.iter().find(|c| &c.chat == chat)
    }

    /// The opened chat's view arrived; true when its chat is still open. Its running turn is
    /// taken and live events after its cursor patch it.
    pub(crate) fn view_loaded(&mut self, chat: &ChatRef, view: SessionView) -> bool {
        self.note_view(chat, &view);
        if self.selected.as_ref() != Some(chat) {
            return false;
        }
        self.progress.load(&view);
        self.messages.open(view);
        true
    }

    /// The latest window of the open chat arrived again: it merges into the shown view.
    pub(crate) fn view_refreshed(&mut self, chat: &ChatRef, view: SessionView) -> bool {
        self.note_view(chat, &view);
        if self.selected.as_ref() != Some(chat) {
            return false;
        }
        self.progress.load(&view);
        self.messages.refresh(view);
        true
    }

    /// An older window arrived; true when it was merged into the shown view.
    pub(crate) fn older_loaded(&mut self, chat: &ChatRef, older: SessionView) -> bool {
        if self.selected.as_ref() != Some(chat) {
            return false;
        }
        self.messages.prepend_older(older);
        true
    }

    fn note_view(&mut self, chat: &ChatRef, view: &SessionView) {
        let events = u64::try_from(view.cursors.events).unwrap_or(0);
        self.message_snapshots
            .insert(chat.session.clone(), EventCursor(events));
        let running = view
            .active_turn
            .as_ref()
            .map(|turn| TurnId(turn.id.clone().into()));
        self.set_running(&chat.chat, running);
    }

    /// The open chat's view disagrees with its running turn: it is read again.
    pub(crate) fn view_stale(&self) -> bool {
        let (Some(chat), Some(view)) = (self.selected.as_ref(), self.messages.view()) else {
            return false;
        };
        let running = self.running.get(&chat.chat).map(|turn| &*turn.0);
        running != view.active_turn.as_ref().map(|turn| turn.id.as_str())
    }

    /// The open chat's view with the turns' live progress: what the transcript renders.
    pub(crate) fn shown_view(&self) -> Option<SessionView> {
        let mut view = self.messages.view()?.clone();
        for turn in [&mut view.active_turn, &mut view.latest_turn]
            .into_iter()
            .flatten()
        {
            if let Some(snapshot) = self.progress.snapshot(&turn.id) {
                turn.progress = Some(snapshot.clone());
                if let Some(state) = &snapshot.state {
                    turn.state.clone_from(state);
                }
            }
        }
        Some(view)
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

    /// Records a session's outstanding requests; true when the open chat's set changed, so its
    /// view (which carries the requests the decision surfaces show) is read again.
    pub(crate) fn authority_loaded(
        &mut self,
        session: SessionId,
        cards: Vec<AuthorityCard>,
    ) -> bool {
        let requests: Vec<RequestRef> = cards.into_iter().map(|card| card.request).collect();
        let open = self
            .selected
            .as_ref()
            .is_some_and(|chat| chat.session == session);
        let changed = self.authority.get(&session) != Some(&requests);
        self.authority.insert(session, requests);
        open && changed
    }

    /// Applies a live event from the stream of snapshot `epoch`; stale streams and replayed
    /// cursors are ignored.
    pub(crate) fn apply(&mut self, epoch: u64, event: LiveEvent) -> Applied {
        if epoch != self.epoch {
            return Applied::Store;
        }
        let previous_cursor = self.cursor;
        if let Some(cursor) = event.cursor {
            if self.cursor.is_some_and(|last| cursor <= last) {
                return Applied::Store;
            }
            self.cursor = Some(cursor);
        }
        match event.update {
            LiveUpdate::NavigationEvent(event) => {
                if u64::try_from(event.id)
                    .is_ok_and(|id| previous_cursor.is_some_and(|last| id <= last.0))
                {
                    return Applied::Store;
                }
                self.navigation.apply_live_event(&event);
            }
            LiveUpdate::Failed(error) => return Applied::Failed(error),
            LiveUpdate::Event {
                session,
                event: raw,
            } => {
                if event.cursor.is_some_and(|c| {
                    self.message_snapshots
                        .get(&session)
                        .is_some_and(|snapshot| c <= *snapshot)
                }) || self.selected.as_ref().map(|chat| &chat.session) != Some(&session)
                {
                    return Applied::Store;
                }
                return self.apply_session_event(&raw);
            }
            LiveUpdate::Turn { chat, running } => {
                let ended = running.is_none() && self.running.contains_key(&chat);
                self.set_running(&chat, running);
                if ended && self.selected.as_ref().is_some_and(|open| open.chat == chat) {
                    self.freeze_activity();
                    return Applied::Transcript;
                }
            }
            LiveUpdate::Authority { session, cards } => {
                if self.authority_loaded(session, cards) {
                    return Applied::Refresh;
                }
            }
            LiveUpdate::Chat(summary) => {
                if self
                    .summary(&summary.chat)
                    .is_some_and(|row| row.updated_at > summary.updated_at)
                {
                    return Applied::Store;
                }
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
            LiveUpdate::Inspector(_) => {}
        }
        Applied::Store
    }

    /// `freezeConversationActivity`: a finished turn's messages keep the activity it showed.
    fn freeze_activity(&mut self) {
        let snapshots: HashMap<String, TurnProgressSnapshot> =
            self.progress.snapshots().iter().cloned().collect();
        progress::terminal::freeze_conversation_activity(self.messages.messages_mut(), &snapshots);
    }

    /// A session event of the open chat: the cache and the progress each take it.
    fn apply_session_event(&mut self, event: &AppEventEnvelope) -> Applied {
        let messages = self.messages.apply_event(event);
        let progress = self.progress.apply_event(event);
        if messages || progress {
            Applied::Transcript
        } else {
            Applied::Store
        }
    }

    /// The agent went away: nothing it owns stays actionable.
    pub(crate) fn lost(&mut self) {
        self.epoch += 1;
        self.loading = None;
        self.running.clear();
        self.authority.clear();
        self.cursor = None;
        self.message_snapshots.clear();
    }
}
