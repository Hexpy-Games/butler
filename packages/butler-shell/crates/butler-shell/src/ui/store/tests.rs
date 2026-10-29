//! The store against a fake source: paging, resync, answers and the live cursor handoff.
use std::cell::RefCell;

use futures::executor::block_on;
use futures::stream::LocalBoxStream;
use futures::{FutureExt as _, StreamExt as _};
use gpui::SharedString;

use super::{Applied, Store};
use crate::ui::source::{
    AuthorityCard, CardKind, ChatId, ChatPage, ChatRef, ChatSummary, ClientMessageId,
    ComposerContext, Decision, EventCursor, Fetch, LiveEvent, LiveUpdate, MessageCursor,
    MessagePage, PageCursor, RequestRef, SentTurn, SessionId, Source, SourceError, Timestamp,
    TurnId,
};

fn chat(n: u32) -> ChatSummary {
    ChatSummary {
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
    fn messages(&self, _: &SessionId, _: Option<MessageCursor>) -> Fetch<MessagePage> {
        ready(Ok(MessagePage {
            messages: Vec::new(),
            older: None,
            running: Some(TurnId("t1".into())),
            events: EventCursor(0),
        }))
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
    fn send(&self, _: &ChatId, _: ClientMessageId, _: String) -> Fetch<SentTurn> {
        ready(Ok(SentTurn {
            turn: TurnId("t".into()),
        }))
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
    fn composer(&self) -> ComposerContext {
        ComposerContext {
            permission: "".into(),
            model: "".into(),
            effort: "".into(),
        }
    }
}

fn titles(store: &Store) -> Vec<String> {
    store.chats.iter().map(|c| c.title.to_string()).collect()
}

// test-category: pure-logic
#[test]
fn paging_and_live_chat_updates_preserve_visible_order() {
    activity_refresh_reorders_an_existing_chat();
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
fn a_failed_answer_keeps_the_card() {
    chat_request_failures_preserve_connection_and_drop_only_missing_resources();
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

// test-category: pure-logic
#[test]
fn message_windows_and_live_rows_keep_roles_deletions_and_running_turns() {
    let (fake, mut store) = (Fake::new(), Store::default());
    let first = store.begin_snapshot();
    store.chats_loaded(&first, block_on(fake.chats(None)).unwrap());
    let chat = chat(1).chat;
    store.open(Some(chat.clone()));
    let page = block_on(fake.messages(&chat.session, None)).unwrap();
    assert!(store.messages_loaded(&chat, &page));
    assert_eq!(store.running(), Some(&TurnId("t1".into())));
    assert!(store.chats.iter().any(|c| c.chat == chat && c.running));
    use crate::ui::source::{Message, Role};
    let mut store = Store::default();
    let message = Message {
        id: "future".into(),
        role: Role::Other("automation".into()),
        text: "Scheduled result".into(),
        activity: Vec::new(),
        streaming: false,
    };
    let applied = store.apply(
        store.epoch(),
        LiveEvent {
            cursor: Some(EventCursor(1)),
            update: LiveUpdate::Message {
                session: chat.session.clone(),
                message,
            },
        },
    );
    let Applied::Message(_, message) = applied else {
        panic!("message discarded")
    };
    assert_eq!(message.role, Role::Other("automation".into()));
    assert_eq!(message.text, "Scheduled result");
    assert_eq!(store.cursor, Some(EventCursor(1)));
    let mut store = Store::default();
    let event = || LiveEvent {
        cursor: Some(EventCursor(1)),
        update: LiveUpdate::MessageDeleted {
            session: chat.session.clone(),
            id: "gone".into(),
        },
    };
    assert!(matches!(
        store.apply(store.epoch() + 1, event()),
        Applied::Store
    ));
    assert!(matches!(store.apply(store.epoch(), event()),
        Applied::MessageDeleted(_, id) if id.as_ref() == "gone"));
    assert!(matches!(
        store.apply(store.epoch(), event()),
        Applied::Store
    ));
}

/// Store regression: refreshed activity uses the server sort key, keeping pins first.
fn activity_refresh_reorders_an_existing_chat() {
    let mut store = Store::default();
    let mut pinned = chat(1);
    pinned.pinned = true;
    store.chats = vec![pinned, chat(3), chat(2)];
    let mut active = chat(2);
    active.updated_at = Timestamp(20);
    store.apply(
        store.epoch(),
        LiveEvent {
            cursor: Some(EventCursor(1)),
            update: LiveUpdate::Turn {
                chat: active.chat.chat.clone(),
                running: None,
            },
        },
    );
    store.apply(
        store.epoch(),
        LiveEvent {
            cursor: Some(EventCursor(2)),
            update: LiveUpdate::Chat(active),
        },
    );
    assert_eq!(titles(&store), ["chat 1", "chat 2", "chat 3"]);
}

/// Store regressions: a failed action preserves the chat; a deleted open chat leaves it.
fn chat_request_failures_preserve_connection_and_drop_only_missing_resources() {
    let mut store = Store::default();
    let open = chat(1).chat;
    store.chats = vec![chat(1), chat(2)];
    store.open(Some(open.clone()));
    store.turn_started(&open.chat, TurnId("running".into()));
    let epoch = store.epoch();
    let cursor = EventCursor(42);
    store.cursor = Some(cursor);
    assert!(!store.chat_failed(&open, &SourceError::Refused("HTTP 503".into())));
    assert_eq!(store.selected(), Some(&open));
    assert!(store.running().is_some());
    assert_eq!(titles(&store), ["chat 1", "chat 2"]);
    assert_eq!(store.epoch(), epoch);
    assert_eq!(store.cursor, Some(cursor));
    assert!(store.chat_failed(&open, &SourceError::Missing));
    assert_eq!(store.selected(), None);
    assert_eq!(store.running(), None);
    assert_eq!(titles(&store), ["chat 2"]);
    assert_eq!(store.epoch(), epoch);
    assert_eq!(store.cursor, Some(cursor));
    store.open(Some(chat(2).chat));
    assert!(!store.chat_failed(&open, &SourceError::Missing));
    assert_eq!(store.selected(), Some(&chat(2).chat));
}
