//! Reuse immutable projection facts only within one delta-only SQL operation.
use crate::gateway::MessageRecord;
use std::{cell::RefCell, collections::HashMap};

#[derive(Default)]
struct Facts {
    messages: HashMap<String, MessageRecord>,
    sequences: HashMap<(String, String), u64>,
}
thread_local! { static FACTS: RefCell<Option<Facts>> = const { RefCell::new(None) }; }
struct Reset(Option<Facts>);
impl Drop for Reset {
    fn drop(&mut self) {
        FACTS.with(|facts| *facts.borrow_mut() = self.0.take());
    }
}
pub(in crate::gateway::application::projection) fn run<T>(operation: impl FnOnce() -> T) -> T {
    let _reset = Reset(FACTS.with(|facts| facts.replace(Some(Facts::default()))));
    operation()
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
