//! Bounded identities from the actual model projection, consumed on completion.
use super::*;
use std::{collections::HashSet, sync::Arc};

#[derive(Clone)]
pub struct VisibleHistory(Arc<HashSet<String>>);

impl VisibleHistory {
    pub(super) fn contains(&self, id: &str) -> bool {
        self.0.contains(id)
    }
}

impl AgentConversationStore {
    /// Records only the identities rendered for the active turn, without a DB read.
    pub fn record_visible_history(&self, session: &str, turns: Vec<String>) {
        if let Ok(mut windows) = self.inner.visible_history.lock() {
            windows.insert(
                session.to_owned(),
                VisibleHistory(Arc::new(turns.into_iter().collect())),
            );
        }
    }

    /// Consumes the projection when its completion schedules a fold.
    pub fn take_visible_history(&self, session: &str) -> Option<VisibleHistory> {
        self.inner.visible_history.lock().ok()?.remove(session)
    }
}
