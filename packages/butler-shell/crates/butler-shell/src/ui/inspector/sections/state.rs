//! The state the session sections read besides the view, kept in one entity so every cached
//! view that shows the sections reads the same thing and nothing is written during render.
use gpui::Context;

use crate::ui::inspector::order::queue;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{SessionPendingAsks, SessionView};

/// What the session sections read besides the view: the open session's pending asks and its
/// canon queue reader. Updated when the shown view changes, never during render.
pub(crate) struct SessionSectionsState {
    /// The (session, event cursor) the asks were last requested for.
    requested: Option<(String, i64)>,
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

    /// Follows the shown view: reads the pending asks again when its event cursor moved and
    /// moves the queue reader to its session.
    pub(crate) fn show(&mut self, view: Option<&SessionView>, cx: &mut Context<Self>) {
        let key = view.map(|view| (view.session_id.clone(), view.cursors.events));
        if key != self.requested {
            self.requested.clone_from(&key);
            match key {
                Some(key) => Self::fetch_asks(key, cx),
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

    fn fetch_asks(key: (String, i64), cx: &mut Context<Self>) {
        let id = key.0.clone();
        let done = Jobs::run(cx, move |client| async move {
            let value = client.get_session_pending_asks(&id).await.ok()?;
            serde_json::from_value::<SessionPendingAsks>(value).ok()
        });
        cx.spawn(async move |this, cx| {
            let Some(page) = done.await.flatten() else {
                return;
            };
            let _ = this.update(cx, |state, cx| {
                if state.requested.as_ref() == Some(&key) {
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
