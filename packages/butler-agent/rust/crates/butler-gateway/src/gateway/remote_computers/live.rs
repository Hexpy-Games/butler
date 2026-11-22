//! Per-computer relay demand, cursors, and subscriptions to the main live stream.
use super::{Link, live_pump};
use crate::gateway::{
    AppEventEnvelope, EventSubscription, GatewayApplication, PublishedEvent, live::LiveListener,
    protocol::APP_PROTOCOL_VERSION,
};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::SystemTime,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::gateway) enum Connection {
    Idle,
    Connecting,
    Connected,
    Reconnecting,
    Unreachable,
}

#[derive(Clone, Default)]
pub(in crate::gateway) struct LiveRelays(Arc<Mutex<Hub>>);

#[derive(Default)]
struct Hub {
    next: u64,
    listeners: HashMap<u64, LiveListener>,
    relays: HashMap<String, Entry>,
    cursors: HashMap<String, u64>,
}

struct Entry {
    state: Connection,
    error: Option<String>,
    demand: u64,
    stop: CancellationToken,
    wake: Arc<Notify>,
}

struct Watch {
    hub: Weak<Mutex<Hub>>,
    id: u64,
}

impl EventSubscription for Watch {}
impl Drop for Watch {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.lock().listeners.remove(&self.id);
        }
    }
}

impl LiveRelays {
    pub(in crate::gateway) fn subscribe(
        &self,
        listener: LiveListener,
    ) -> Box<dyn EventSubscription> {
        let mut hub = self.0.lock();
        let id = hub.next;
        hub.next += 1;
        for (computer, entry) in &hub.relays {
            listener(Arc::new(PublishedEvent::new(status(
                computer,
                entry.state,
                entry.error.as_deref(),
            ))));
        }
        hub.listeners.insert(id, listener);
        Box::new(Watch {
            hub: Arc::downgrade(&self.0),
            id,
        })
    }

    pub(in crate::gateway) fn ensure(
        &self,
        link: Link,
        application: Arc<dyn GatewayApplication>,
        computer: &str,
    ) -> bool {
        if link.cancel.is_cancelled() {
            return false;
        }
        let mut hub = self.0.lock();
        if let Some(entry) = hub.relays.get_mut(computer) {
            entry.demand += 1;
            if entry.state == Connection::Unreachable {
                entry.wake.notify_one();
            }
            return false;
        }
        let stop = link.cancel.child_token();
        let wake = Arc::new(Notify::new());
        hub.relays.insert(
            computer.to_owned(),
            Entry {
                state: Connection::Connecting,
                error: None,
                demand: 0,
                stop: stop.clone(),
                wake: wake.clone(),
            },
        );
        let event = Arc::new(PublishedEvent::new(status(
            computer,
            Connection::Connecting,
            None,
        )));
        for listener in hub.listeners.values() {
            listener(event.clone());
        }
        drop(hub);
        tokio::spawn(live_pump::run(live_pump::Pump {
            relays: self.clone(),
            link,
            application,
            computer: computer.to_owned(),
            stop,
            wake,
        }));
        true
    }

    pub(in crate::gateway) fn connection(&self, computer: &str) -> (Connection, Option<String>) {
        self.0
            .lock()
            .relays
            .get(computer)
            .map_or((Connection::Idle, None), |entry| {
                (entry.state, entry.error.clone())
            })
    }

    pub(in crate::gateway) fn reconnect(
        &self,
        link: Link,
        application: Arc<dyn GatewayApplication>,
        computer: &str,
    ) -> (Connection, Option<String>) {
        let hub = self.0.lock();
        if let Some(entry) = hub.relays.get(computer) {
            entry.wake.notify_one();
            drop(hub);
        } else {
            drop(hub);
            self.ensure(link, application, computer);
        }
        self.connection(computer)
    }

    pub(in crate::gateway) fn stop(&self, computer: &str) {
        let mut hub = self.0.lock();
        hub.cursors.remove(computer);
        if let Some(entry) = hub.relays.remove(computer) {
            entry.stop.cancel();
            let event = Arc::new(PublishedEvent::new(status(
                computer,
                Connection::Idle,
                None,
            )));
            for listener in hub.listeners.values() {
                listener(event.clone());
            }
        }
    }

    pub(super) fn set(
        &self,
        computer: &str,
        wake: &Arc<Notify>,
        state: Connection,
        error: Option<String>,
    ) {
        let mut hub = self.0.lock();
        let Some(entry) = hub.relays.get_mut(computer) else {
            return;
        };
        if !Arc::ptr_eq(&entry.wake, wake) || (entry.state == state && entry.error == error) {
            return;
        }
        entry.state = state;
        entry.error = error;
        let event = Arc::new(PublishedEvent::new(status(
            computer,
            state,
            entry.error.as_deref(),
        )));
        for listener in hub.listeners.values() {
            listener(event.clone());
        }
    }

    pub(super) fn demand(&self, computer: &str, wake: &Arc<Notify>) -> Option<u64> {
        self.0
            .lock()
            .relays
            .get(computer)
            .filter(|entry| Arc::ptr_eq(&entry.wake, wake))
            .map(|entry| entry.demand)
    }

    pub(super) fn finish(&self, computer: &str, wake: &Arc<Notify>, seen: u64) -> bool {
        let mut hub = self.0.lock();
        let Some(entry) = hub
            .relays
            .get(computer)
            .filter(|entry| Arc::ptr_eq(&entry.wake, wake))
        else {
            return true;
        };
        if entry.demand != seen {
            return false;
        }
        hub.relays.remove(computer);
        let event = Arc::new(PublishedEvent::new(status(
            computer,
            Connection::Idle,
            None,
        )));
        for listener in hub.listeners.values() {
            listener(event.clone());
        }
        true
    }

    pub(super) fn emit(&self, event: AppEventEnvelope) {
        let listeners: Vec<_> = self.0.lock().listeners.values().cloned().collect();
        let event = Arc::new(PublishedEvent::new(event));
        for listener in listeners {
            listener(event.clone());
        }
    }

    pub(super) fn cursor(&self, computer: &str) -> Option<u64> {
        self.0.lock().cursors.get(computer).copied()
    }

    pub(super) fn set_cursor(&self, computer: &str, wake: &Arc<Notify>, id: u64) {
        let mut hub = self.0.lock();
        if hub
            .relays
            .get(computer)
            .is_some_and(|entry| Arc::ptr_eq(&entry.wake, wake))
        {
            hub.cursors.insert(computer.to_owned(), id);
        }
    }
}

fn status(computer: &str, state: Connection, error: Option<&str>) -> AppEventEnvelope {
    AppEventEnvelope {
        id: 0,
        event_type: "remote.connection_changed".to_owned(),
        protocol_version: APP_PROTOCOL_VERSION.to_owned(),
        created_at: butler_core::js_date::iso_from_system_time(SystemTime::now()),
        payload: serde_json::Map::from_iter([
            ("computer_id".into(), json!(computer)),
            ("state".into(), json!(state)),
            ("error".into(), json!(error)),
        ]),
    }
}
