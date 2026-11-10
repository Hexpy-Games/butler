//! The state the session sections read besides the view, kept in one entity so every cached
//! view that shows the sections reads the same thing and nothing is written during render.
use gpui::Context;
use serde_json::Value;

use crate::ui::inspector::order::queue;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{AppEventEnvelope, SessionPendingAsks, SessionView};

/// What the session sections read besides the view: the open session's pending asks and its
/// canon queue reader. Updated when the shown view changes, never during render.
pub(crate) struct SessionSectionsState {
    /// The session the asks were last requested for.
    requested: Option<String>,
    asks: Option<SessionPendingAsks>,
    /// The session whose canon queue reader this holds (released when it changes or drops).
    queue_session: Option<String>,
}

impl SessionSectionsState {
    /// An empty state; it releases its queue reader when the entity is dropped.
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        cx.on_release(|state, cx| {
            if let Some(id) = state.queue_session.take() {
                queue::release(cx, &id);
            }
        })
        .detach();
        Self {
            requested: None,
            asks: None,
            queue_session: None,
        }
    }

    /// Follows the shown view: reads the pending asks when the shown session changes and
    /// moves the queue reader to its session.
    pub(crate) fn show(&mut self, view: Option<&SessionView>, cx: &mut Context<Self>) {
        let key = view.map(|view| view.session_id.clone());
        if key != self.requested {
            self.requested.clone_from(&key);
            match key {
                Some(id) => Self::fetch_asks(id, cx),
                None => {
                    self.asks = None;
                    cx.notify();
                }
            }
        }
        let session = view.map(|view| view.session_id.as_str());
        if self.queue_session.as_deref() != session {
            if let Some(old) = self.queue_session.take() {
                queue::release(cx, &old);
            }
            if let Some(id) = session {
                queue::observe(cx, id);
            }
            self.queue_session = session.map(str::to_owned);
        }
    }

    /// `publishPendingAsksEvent` (Electron `client/ui/src/app/pendingAsks.ts`): after the first
    /// read, the asks are read again only on the live events that change them.
    pub(crate) fn live_event(&mut self, event: &AppEventEnvelope, cx: &mut Context<Self>) {
        let Some(session) = self.requested.clone() else {
            return;
        };
        let payload = &event.payload;
        let refetch = match event.r#type.as_str() {
            "stream.reconcile_required" => true,
            "pending_asks.changed" => payload["session_id"].as_str() == Some(session.as_str()),
            "message.created" | "message.updated" => self.stale_source(payload),
            _ => false,
        };
        if refetch {
            Self::fetch_asks(session, cx);
        }
    }

    /// Whether an assistant reply replaced the source reply of an ask on the current page.
    fn stale_source(&self, payload: &Value) -> bool {
        let message = &payload["message"];
        let (Some(chat), Some(turn), Some(id)) = (
            message["chat_id"].as_str(),
            message["turn_id"].as_str(),
            message["id"].as_str(),
        ) else {
            return false;
        };
        message["role"].as_str() == Some("assistant")
            && self.asks.as_ref().is_some_and(|page| {
                page.asks.iter().any(|ask| {
                    ask.source_session_id == chat
                        && ask.source_turn_id == turn
                        && ask.source_message_id.as_deref() != Some(id)
                })
            })
    }

    fn fetch_asks(id: String, cx: &mut Context<Self>) {
        let session = id.clone();
        let done = Jobs::run(cx, move |client| async move {
            let value = client.get_session_pending_asks(&session).await.ok()?;
            serde_json::from_value::<SessionPendingAsks>(value).ok()
        });
        cx.spawn(async move |this, cx| {
            let Some(page) = done.await.flatten() else {
                return;
            };
            let _ = this.update(cx, |state, cx| {
                // An unchanged page notifies nothing: the Shell redraws every Region on it.
                if state.requested.as_deref() == Some(id.as_str())
                    && state.asks.as_ref() != Some(&page)
                {
                    state.asks = Some(page);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// The pending asks page of `session_id`; `None` until one arrives.
    pub(crate) fn asks(&self, session_id: &str) -> Option<&SessionPendingAsks> {
        self.asks
            .as_ref()
            .filter(|page| page.session_id == session_id)
    }
}
