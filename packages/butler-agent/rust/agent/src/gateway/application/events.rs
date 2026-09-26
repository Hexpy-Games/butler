//! Durable event rows and bounded synchronous subscriber publication.

use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
};

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use super::storage::AppStorageError;
use crate::gateway::{AppEventEnvelope, EventSubscription};

const APP_PROTOCOL_VERSION: &str = "butler.app.v1";

#[derive(Clone, Default)]
pub(super) struct EventSubscribers {
    inner: Arc<Mutex<SubscriberState>>,
}

#[derive(Default)]
struct SubscriberState {
    next_id: u64,
    listeners: HashMap<u64, Arc<dyn Fn(AppEventEnvelope) + Send + Sync>>,
    cursor_observer: Option<Arc<dyn Fn(u64) + Send + Sync>>,
}

impl EventSubscribers {
    pub(super) fn observe_cursor(&self, observer: Arc<dyn Fn(u64) + Send + Sync>) {
        self.inner.lock().cursor_observer = Some(observer);
    }
    pub(super) fn subscribe(
        &self,
        listener: Arc<dyn Fn(AppEventEnvelope) + Send + Sync>,
    ) -> Box<dyn EventSubscription> {
        let mut state = self.inner.lock();
        state.next_id += 1;
        let id = state.next_id;
        state.listeners.insert(id, listener);
        Box::new(Subscription {
            owner: Arc::downgrade(&self.inner),
            id,
        })
    }

    pub(super) fn publish(&self, event: &AppEventEnvelope) {
        let (listeners, cursor_observer) = {
            let state = self.inner.lock();
            (
                state.listeners.values().cloned().collect::<Vec<_>>(),
                state.cursor_observer.clone(),
            )
        };
        if let Some(observer) = cursor_observer {
            observer(event.id);
        }
        for listener in listeners {
            listener(event.clone());
        }
    }
}

struct Subscription {
    owner: Weak<Mutex<SubscriberState>>,
    id: u64,
}
impl EventSubscription for Subscription {}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.upgrade() {
            owner.lock().listeners.remove(&self.id);
        }
    }
}

pub(super) fn append(
    connection: &Connection,
    subscribers: &EventSubscribers,
    event_type: &str,
    turn_id: Option<&str>,
    payload: Map<String, Value>,
    created_at: &str,
) -> Result<AppEventEnvelope, AppStorageError> {
    let event = append_unpublished(connection, event_type, turn_id, payload, created_at)?;
    subscribers.publish(&event.clone());
    Ok(event)
}

pub(super) fn append_unpublished(
    connection: &Connection,
    event_type: &str,
    turn_id: Option<&str>,
    payload: Map<String, Value>,
    created_at: &str,
) -> Result<AppEventEnvelope, AppStorageError> {
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| AppStorageError::new("app_event_json_failed", error.to_string()))?;
    let turn_id = turn_id.unwrap_or("");
    connection
        .execute(
            "INSERT INTO events(type,turn_id,payload_json,created_at) VALUES(?1,?2,?3,?4)",
            params![event_type, turn_id, payload_json, created_at],
        )
        .map_err(AppStorageError::sqlite)?;
    let id = connection.last_insert_rowid() as u64;
    let event = AppEventEnvelope {
        protocol_version: APP_PROTOCOL_VERSION.to_owned(),
        id,
        event_type: event_type.to_owned(),
        created_at: created_at.to_owned(),
        payload,
    };
    Ok(event)
}

pub(super) fn publish(subscribers: &EventSubscribers, event: &AppEventEnvelope) {
    subscribers.publish(event);
}

pub(super) fn latest(connection: &Connection) -> Result<u64, AppStorageError> {
    connection
        .query_row("SELECT COALESCE(MAX(id),0) FROM events", [], |row| {
            row.get(0)
        })
        .map_err(AppStorageError::sqlite)
}

pub(super) fn replay(
    connection: &Connection,
    after: f64,
    limit: usize,
) -> Result<Vec<AppEventEnvelope>, AppStorageError> {
    let cursor = if after.is_finite() { after } else { 0.0 };
    let mut statement = connection
        .prepare(
            "SELECT id,type,payload_json,created_at FROM events \
        WHERE id>?1 ORDER BY id ASC LIMIT ?2",
        )
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map(params![cursor, limit.clamp(1, 200)], |row| {
            let payload_json: String = row.get(2)?;
            let payload =
                serde_json::from_str::<Map<String, Value>>(&payload_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(AppEventEnvelope {
                protocol_version: APP_PROTOCOL_VERSION.to_owned(),
                id: row.get(0)?,
                event_type: row.get(1)?,
                created_at: row.get(3)?,
                payload,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
