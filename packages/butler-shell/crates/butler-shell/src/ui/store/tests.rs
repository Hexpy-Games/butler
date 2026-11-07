//! The store against a fake source: paging, resync, answers and the live cursor handoff.
use std::cell::RefCell;

use futures::executor::block_on;
use futures::stream::LocalBoxStream;
use futures::{FutureExt as _, StreamExt as _};
use gpui::SharedString;

use super::{Applied, Store};
use crate::ui::source::{
    AuthorityCard, ChatId, ChatPage, ChatRef, ChatSummary, EventCursor, Fetch,
    LiveEvent, LiveUpdate, PageCursor, RequestRef, SessionId, Source, SourceError, Timestamp,
    TurnId,
    wire::{AppEventEnvelope, SessionView},
};

fn chat(n: u32) -> ChatSummary {
    ChatSummary {
        waiting: false,
        chat: ChatRef {
            chat: ChatId(format!("c{n}").into()),
            session: SessionId(format!("s{n}").into()),
        },
        title: SharedString::from(format!("chat {n}")),
        space: None,
        pinned: false,
        archived: false,
        created_at: Timestamp(0),
        running: false,
        updated_at: Timestamp(0),
    }
}

/// Two pages of chats per snapshot (snapshot `n` has event cursor `10 * n`), live events
/// after a cursor.
struct Fake {
    snapshot: RefCell<u64>,
}

impl Fake {
    fn new() -> Self {
        Self {
            snapshot: RefCell::new(0),
        }
    }
}

fn ready<T: 'static>(value: Result<T, SourceError>) -> Fetch<T> {
    futures::future::ready(value).boxed_local()
}

impl Source for Fake {
    fn chats(&self, cursor: Option<PageCursor>) -> Fetch<ChatPage> {
        if cursor.is_none() {
            *self.snapshot.borrow_mut() += 1;
        }
        let snapshot = *self.snapshot.borrow();
        let page = match cursor {
            None => ChatPage {
                chats: vec![chat(1), chat(2)],
                next: Some(PageCursor("p2".into())),
                events: EventCursor(10 * snapshot),
            },
            Some(_) => ChatPage {
                chats: vec![chat(3)],
                next: None,
                events: EventCursor(10 * snapshot),
            },
        };
        ready(Ok(page))
    }
    fn open_session(&self, session: &SessionId) -> Fetch<SessionView> {
        ready(Ok(view(session, Some("t1"))))
    }
    fn session_view(&self, session: &SessionId, _: Option<String>) -> Fetch<SessionView> {
        ready(Ok(view(session, None)))
    }
    fn authority(&self, _: &SessionId) -> Fetch<Vec<AuthorityCard>> {
        let card = AuthorityCard {
            request: RequestRef("r1".into()),
            tool: None,
        };
        ready(Ok(vec![card]))
    }
    fn live(&self, after: EventCursor) -> LocalBoxStream<'static, LiveEvent> {
        let event = |c: u64| LiveEvent {
            cursor: Some(EventCursor(c)),
            update: LiveUpdate::Turn {
                chat: ChatId("c1".into()),
                running: Some(TurnId(format!("t{c}").into())),
            },
        };
        futures::stream::iter((after.0..=after.0 + 1).map(event)).boxed_local()
    }
    fn create_chat(&self) -> Fetch<ChatRef> {
        ready(Ok(chat(9).chat))
    }
    fn cancel(&self, _: &TurnId) -> Fetch<()> {
        ready(Ok(()))
    }
}

fn titles(store: &Store) -> Vec<String> {
    store.chats.iter().map(|c| c.title.to_string()).collect()
}

// test-category: pure-logic
#[test]
fn paging_and_live_chat_updates_preserve_visible_order() {
    let (fake, mut store) = (Fake::new(), Store::default());
    let first = store.begin_snapshot();
    assert!(
        store.begin_more().is_none(),
        "no second load while one is in flight"
    );
    store.chats_loaded(&first, block_on(fake.chats(first.cursor.clone())).unwrap());
    let more = store.begin_more().expect("a next page");
    store.chats_loaded(&more, block_on(fake.chats(more.cursor.clone())).unwrap());
    assert_eq!(titles(&store), ["chat 1", "chat 2", "chat 3"]);
    assert!(
        store.begin_more().is_none(),
        "the last page has no next cursor"
    );
    let mut store = Store::default();
    let mut pinned = chat(1);
    pinned.pinned = true;
    store.chats = vec![pinned, chat(2)];
    let mut updated = chat(3);
    updated.updated_at = Timestamp(10);
    let apply = |store: &mut Store, row| {
        store.apply(
            store.epoch(),
            LiveEvent {
                cursor: None,
                update: LiveUpdate::Chat(row),
            },
        );
    };
    apply(&mut store, updated.clone());
    assert_eq!(titles(&store), ["chat 1", "chat 3", "chat 2"]);
    updated.pinned = true;
    apply(&mut store, updated.clone());
    assert_eq!(titles(&store), ["chat 3", "chat 1", "chat 2"]);
    updated.archived = true;
    apply(&mut store, updated);
    assert_eq!(titles(&store), ["chat 1", "chat 2"]);
}

// test-category: pure-logic
#[test]
fn resync_supersedes_a_load_in_flight_and_keeps_the_list() {
    let (fake, mut store) = (Fake::new(), Store::default());
    let first = store.begin_snapshot();
    store.chats_loaded(&first, block_on(fake.chats(None)).unwrap());
    let more = store.begin_more().expect("a next page");
    let stale = block_on(fake.chats(more.cursor.clone())).unwrap();
    let resync = store.begin_snapshot();
    assert_eq!(
        store.chats_loaded(&more, stale),
        None,
        "the old snapshot's page is dropped"
    );
    assert_eq!(
        titles(&store),
        ["chat 1", "chat 2"],
        "the list stays while the new snapshot loads"
    );
    let cursor = store.chats_loaded(&resync, block_on(fake.chats(None)).unwrap());
    assert_eq!(
        cursor,
        Some(EventCursor(20)),
        "the new snapshot hands its cursor to live"
    );
    assert_eq!(titles(&store), ["chat 1", "chat 2"]);
}

// test-category: pure-logic
#[test]
fn live_resumes_after_the_snapshot_cursor() {
    let (fake, mut store) = (Fake::new(), Store::default());
    let first = store.begin_snapshot();
    let after = store
        .chats_loaded(&first, block_on(fake.chats(None)).unwrap())
        .expect("cursor");
    store.open(Some(chat(1).chat));
    let epoch = store.epoch();
    // The stream replays the snapshot's own cursor (10) first: it is not applied twice.
    for event in block_on(fake.live(after).collect::<Vec<_>>()) {
        assert!(matches!(store.apply(epoch, event), Applied::Store));
    }
    assert_eq!(
        store.running(),
        Some(&TurnId("t11".into())),
        "only the event after the cursor counts"
    );
    let resync = store.begin_snapshot();
    let old = LiveEvent {
        cursor: Some(EventCursor(12)),
        update: LiveUpdate::Resync,
    };
    assert!(
        matches!(store.apply(epoch, old), Applied::Store),
        "the old stream is ignored"
    );
    let gap = LiveEvent {
        cursor: None,
        update: LiveUpdate::Resync,
    };
    assert!(matches!(store.apply(resync.epoch, gap), Applied::Resync));
}

/// A session view of `session` with one user message and a running turn `turn`.
fn view(session: &SessionId, turn: Option<&str>) -> SessionView {
    let turn = turn.map(|id| {
        serde_json::json!({"id": id, "state": "thinking", "cancellable": true, "retryable": false,
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"})
    });
    serde_json::from_value(serde_json::json!({
        "session_id": session.0.as_ref(), "kind": "chat", "status": "active",
        "active_turn": turn,
        "messages": [{"id": "m1", "chat_id": session.0.as_ref(), "role": "user", "text": "hi",
            "cursor": 1}],
        "message_window": {"next_cursor": 1, "complete": true},
        "cursors": {"messages": 1, "events": 5},
        "generated_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"
    }))
    .unwrap()
}

fn message_event(session: &SessionId, kind: &str, payload: serde_json::Value) -> LiveEvent {
    LiveEvent {
        cursor: Some(EventCursor(6)),
        update: LiveUpdate::Event {
            session: session.clone(),
            event: Box::new(AppEventEnvelope {
                protocol_version: "1".into(),
                id: 6,
                r#type: kind.into(),
                created_at: "2026-01-01T00:00:01Z".into(),
                payload,
            }),
        },
    }
}

// test-category: pure-logic
#[test]
fn session_views_and_live_events_keep_messages_deletions_and_running_turns() {
    let (fake, mut store) = (Fake::new(), Store::default());
    let first = store.begin_snapshot();
    store.chats_loaded(&first, block_on(fake.chats(None)).unwrap());
    let chat = chat(1).chat;
    store.open(Some(chat.clone()));
    let view = block_on(fake.open_session(&chat.session)).unwrap();
    assert!(store.view_loaded(&chat, view));
    assert_eq!(store.running(), Some(&TurnId("t1".into())));
    assert!(store.chats.iter().any(|c| c.chat == chat && c.running));
    let added = serde_json::json!({"message": {"id": "future", "chat_id": chat.session.0.as_ref(),
        "role": "automation", "text": "Scheduled result", "cursor": 2}});
    let applied = store.apply(
        store.epoch(),
        message_event(&chat.session, "message.created", added),
    );
    assert!(matches!(applied, Applied::Transcript));
    let shown = store.shown_view().unwrap();
    assert!(shown.messages.iter().any(|m| m.text == "Scheduled result"));
    assert_eq!(store.cursor, Some(EventCursor(6)));
    let deleted = serde_json::json!({"chat_id": chat.session.0.as_ref(), "message_id": "future"});
    let event = |cursor: u64| {
        let mut event = message_event(&chat.session, "message.deleted", deleted.clone());
        event.cursor = Some(EventCursor(cursor));
        event
    };
    assert!(matches!(
        store.apply(store.epoch() + 1, event(7)),
        Applied::Store
    ));
    assert!(matches!(
        store.apply(store.epoch(), event(7)),
        Applied::Transcript
    ));
    assert!(matches!(
        store.apply(store.epoch(), event(7)),
        Applied::Store
    ));
    let shown = store.shown_view().unwrap();
    assert!(shown.messages.iter().all(|m| m.id != "future"));
}
