//! The store against a fake source: paging, resync, answers and the live cursor handoff.
use std::cell::RefCell;

use futures::executor::block_on;
use futures::stream::LocalBoxStream;
use futures::{FutureExt as _, StreamExt as _};
use gpui::SharedString;

use super::{Applied, Store};
use crate::ui::source::{
    AuthorityCard, CardKind, ChatId, ChatPage, ChatRef, ChatSummary, Decision, EventCursor, Fetch,
    LiveEvent, LiveUpdate, RequestRef, SessionId, Source, SourceError, Timestamp,
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

/// A page of chats per snapshot (snapshot `n` has event cursor `10 * n`), live events
/// after a cursor, and an answer that fails until told otherwise.
struct Fake {
    snapshot: RefCell<u64>,
    answer_ok: RefCell<bool>,
}

impl Fake {
    fn new() -> Self {
        Self {
            snapshot: RefCell::new(0),
            answer_ok: RefCell::new(false),
        }
    }
}

fn ready<T: 'static>(value: Result<T, SourceError>) -> Fetch<T> {
    futures::future::ready(value).boxed_local()
}

impl Source for Fake {
    fn chats(&self) -> Fetch<ChatPage> {
        *self.snapshot.borrow_mut() += 1;
        let snapshot = *self.snapshot.borrow();
        let page = ChatPage {
            chats: vec![chat(1), chat(2)],
            events: EventCursor(10 * snapshot),
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
            kind: CardKind::Command,
            reason: "".into(),
            approval: None,
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
    fn answer(&self, _: &SessionId, _: &RequestRef, _: Decision) -> Fetch<()> {
        ready(if *self.answer_ok.borrow() {
            Ok(())
        } else {
            Err(SourceError::Refused("busy".into()))
        })
    }
}

fn titles(store: &Store) -> Vec<String> {
    store.chats.iter().map(|c| c.title.to_string()).collect()
}

// test-category: pure-logic
#[test]
fn live_chat_updates_preserve_visible_order() {
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
    store.chats_loaded(&first, block_on(fake.chats()).unwrap());
    let more = store.begin_snapshot();
    let stale = block_on(fake.chats()).unwrap();
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
    let cursor = store.chats_loaded(&resync, block_on(fake.chats()).unwrap());
    assert_eq!(
        cursor,
        Some(EventCursor(30)),
        "the new snapshot hands its cursor to live"
    );
    assert_eq!(titles(&store), ["chat 1", "chat 2"]);
}

// test-category: pure-logic
#[test]
fn a_failed_answer_keeps_the_card() {
    let (fake, mut store) = (Fake::new(), Store::default());
    let chat = chat(1).chat;
    store.open(Some(chat.clone()));
    store.authority_loaded(
        chat.session.clone(),
        block_on(fake.authority(&chat.session)).unwrap(),
    );
    let request = store.approval().expect("a card").request.clone();
    assert!(store.begin_answer(&request));
    assert!(!store.begin_answer(&request), "one answer at a time");
    assert!(store.is_pending(&request));
    let result = block_on(fake.answer(&chat.session, &request, Decision::AllowOnce));
    assert!(result.is_err());
    store.answer_failed(&request);
    assert!(!store.is_pending(&request));
    assert_eq!(
        store.approval().map(|c| c.request.clone()),
        Some(request.clone()),
        "the card is back"
    );
    *fake.answer_ok.borrow_mut() = true;
    assert!(store.begin_answer(&request));
    block_on(fake.answer(&chat.session, &request, Decision::Deny)).unwrap();
    store.answer_done(&chat.session, &request);
    assert!(store.approval().is_none());
}

// test-category: pure-logic
#[test]
fn live_resumes_after_the_snapshot_cursor() {
    let (fake, mut store) = (Fake::new(), Store::default());
    let first = store.begin_snapshot();
    let after = store
        .chats_loaded(&first, block_on(fake.chats()).unwrap())
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

/// Past the snapshot's event cursor (10) and the session view's (5), so the store applies it.
fn message_event(session: &SessionId, kind: &str, payload: serde_json::Value) -> LiveEvent {
    LiveEvent {
        cursor: Some(EventCursor(11)),
        update: LiveUpdate::Event {
            session: session.clone(),
            event: Box::new(AppEventEnvelope {
                protocol_version: "1".into(),
                id: 11,
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
    store.chats_loaded(&first, block_on(fake.chats()).unwrap());
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
    assert_eq!(store.cursor, Some(EventCursor(11)));
    let deleted = serde_json::json!({"chat_id": chat.session.0.as_ref(), "message_id": "future"});
    let event = |cursor: u64| {
        let mut event = message_event(&chat.session, "message.deleted", deleted.clone());
        event.cursor = Some(EventCursor(cursor));
        event
    };
    assert!(matches!(
        store.apply(store.epoch() + 1, event(12)),
        Applied::Store
    ));
    assert!(matches!(
        store.apply(store.epoch(), event(12)),
        Applied::Transcript
    ));
    assert!(matches!(
        store.apply(store.epoch(), event(12)),
        Applied::Store
    ));
    let shown = store.shown_view().unwrap();
    assert!(shown.messages.iter().all(|m| m.id != "future"));
}
