//! Reuse projection facts only within one delta-only SQL operation.
use crate::gateway::{
    MessageRecord,
    application::{
        queue,
        storage::{AppStorageError, CachedSql},
    },
};
use rusqlite::{Connection, params};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};

#[derive(Default)]
struct Facts {
    messages: HashMap<String, MessageRecord>,
    sequences: HashMap<(String, String), u64>,
    streams: HashMap<String, String>,
    fences: HashSet<(String, String, String)>,
    chats: HashMap<String, String>,
}
thread_local! { static FACTS: RefCell<Option<Facts>> = const { RefCell::new(None) }; }
struct Reset(Option<Facts>);
impl Drop for Reset {
    fn drop(&mut self) {
        FACTS.with(|facts| *facts.borrow_mut() = self.0.take());
    }
}
pub(in crate::gateway::application::projection) fn run<T>(
    db: &mut Connection,
    operation: impl FnOnce(&mut Connection) -> Result<T, AppStorageError>,
) -> Result<T, AppStorageError> {
    debug_assert!(
        !db.is_autocommit(),
        "delta facts require one reserved write transaction"
    );
    let _reset = Reset(FACTS.with(|facts| facts.replace(Some(Facts::default()))));
    let value = operation(db)?;
    persist_messages(db)?;
    persist_chats(db)?;
    Ok(value)
}

// Delta-only batches cannot settle or replace a queued claim. The first fence
// holds the same SQLite write reservation through every delta and publication.
pub(super) fn fence(
    db: &Connection,
    chat: &str,
    turn: &str,
    claim: &str,
) -> Result<bool, AppStorageError> {
    let key = (chat.to_owned(), turn.to_owned(), claim.to_owned());
    if FACTS.with(|facts| {
        facts
            .borrow()
            .as_ref()
            .is_some_and(|facts| facts.fences.contains(&key))
    }) {
        return Ok(true);
    }
    let fenced = queue::fence(db, chat, turn, claim)?;
    if fenced {
        FACTS.with(|facts| {
            if let Some(facts) = facts.borrow_mut().as_mut() {
                facts.fences.insert(key);
            }
        });
    }
    Ok(fenced)
}

pub(super) fn update_chat(db: &Connection, chat: &str, now: &str) -> Result<(), AppStorageError> {
    let buffered = FACTS.with(|facts| {
        if let Some(facts) = facts.borrow_mut().as_mut() {
            facts.chats.insert(chat.to_owned(), now.to_owned());
            true
        } else {
            false
        }
    });
    if !buffered {
        db.execute_cached(
            "UPDATE chats SET updated_at=?1 WHERE id=?2",
            params![now, chat],
        )
        .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}

fn persist_chats(db: &Connection) -> Result<(), AppStorageError> {
    FACTS.with(|facts| {
        let facts = facts.borrow();
        if let Some(facts) = facts.as_ref() {
            for (chat, now) in &facts.chats {
                db.execute_cached(
                    "UPDATE chats SET updated_at=?1 WHERE id=?2",
                    params![now, chat],
                )
                .map_err(AppStorageError::sqlite)?;
            }
        }
        Ok(())
    })
}

// Intermediate message updates are published in full; only the last row state
// is externally visible at commit. Persist the final cached state before commit.
fn persist_messages(db: &Connection) -> Result<(), AppStorageError> {
    FACTS.with(|facts| {
        let facts = facts.borrow();
        let Some(facts) = facts.as_ref() else { return Ok(()) };
        for message in facts.messages.values() {
            db.execute_cached("UPDATE messages SET text=?1,updated_at=?2 WHERE id=?3",
                params![message.text, message.updated_at, message.id])
                .map_err(AppStorageError::sqlite)?;
            if let Some(turn) = &message.turn_id
                && let Some(stream) = facts.streams.get(turn)
            {
                db.execute_cached("UPDATE turn_stream_drafts SET stream_id=?1,discarded=0,updated_at=?2 WHERE turn_id=?3",
                    params![stream, message.updated_at, turn]).map_err(AppStorageError::sqlite)?;
            }
        }
        Ok(())
    })
}
pub(super) fn message(id: &str) -> Option<MessageRecord> {
    FACTS.with(|facts| facts.borrow().as_ref()?.messages.get(id).cloned())
}
pub(super) fn remember(message: &MessageRecord) {
    FACTS.with(|facts| {
        if let Some(facts) = facts.borrow_mut().as_mut() {
            facts.messages.insert(message.id.clone(), message.clone());
        }
    });
}
pub(super) fn stream_message(chat: &str, turn: &str) -> Option<MessageRecord> {
    FACTS.with(|facts| {
        facts
            .borrow()
            .as_ref()?
            .messages
            .values()
            .find(|message| message.chat_id == chat && message.turn_id.as_deref() == Some(turn))
            .cloned()
    })
}
pub(super) fn stream(turn: &str) -> Option<String> {
    FACTS.with(|facts| facts.borrow().as_ref()?.streams.get(turn).cloned())
}
pub(super) fn remember_stream(turn: &str, stream: &str) {
    FACTS.with(|facts| {
        if let Some(facts) = facts.borrow_mut().as_mut() {
            facts.streams.insert(turn.to_owned(), stream.to_owned());
        }
    });
}
pub(in crate::gateway::application::projection) fn sequence(field: &str, id: &str) -> Option<u64> {
    FACTS.with(|facts| {
        facts
            .borrow()
            .as_ref()?
            .sequences
            .get(&(field.to_owned(), id.to_owned()))
            .copied()
    })
}
pub(in crate::gateway::application::projection) fn observed(field: &str, id: &str, sequence: u64) {
    FACTS.with(|facts| {
        if let Some(facts) = facts.borrow_mut().as_mut() {
            facts
                .sequences
                .insert((field.to_owned(), id.to_owned()), sequence);
        }
    });
}

pub(super) fn observe_event(
    chat: &str,
    turn: &str,
    event: &serde_json::Map<String, serde_json::Value>,
) {
    for (field, identity, sequence_field) in [
        ("sessionId", chat, "sessionSequence"),
        ("turnId", turn, "turnSequence"),
    ] {
        if let Some(sequence) = event
            .get(sequence_field)
            .and_then(serde_json::Value::as_u64)
        {
            observed(field, identity, sequence);
        }
    }
}

pub(in crate::gateway::application::projection) fn active() -> bool {
    FACTS.with(|facts| facts.borrow().is_some())
}
