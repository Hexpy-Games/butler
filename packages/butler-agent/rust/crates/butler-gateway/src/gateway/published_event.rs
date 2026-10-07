//! A committed event on its way to the live streams.

use std::sync::OnceLock;

use axum::body::Bytes;

use super::AppEventEnvelope;

/// Dropping the subscription must synchronously unregister its callback.
pub trait EventSubscription: Send {}

/// One committed event shared by every live listener. Its Server-Sent-Events
/// frame is serialized once, on first use, however many streams are connected.
pub struct PublishedEvent {
    event: AppEventEnvelope,
    frame: OnceLock<Bytes>,
}

impl PublishedEvent {
    pub fn new(event: AppEventEnvelope) -> Self {
        Self {
            event,
            frame: OnceLock::new(),
        }
    }

    pub fn id(&self) -> u64 {
        self.event.id
    }

    /// The `id:`/`data:` frame of this event; cloning it shares the bytes.
    pub fn frame(&self) -> Bytes {
        self.frame.get_or_init(|| event_frame(&self.event)).clone()
    }
}

/// The Server-Sent-Events frame of an event that was not published live (a
/// replayed or synthesized one).
pub(super) fn event_frame(event: &AppEventEnvelope) -> Bytes {
    // An envelope of strings, an integer and a JSON map always serializes.
    let data = serde_json::to_string(event).unwrap_or_default();
    Bytes::from(format!("id: {}\ndata: {data}\n\n", event.id))
}
