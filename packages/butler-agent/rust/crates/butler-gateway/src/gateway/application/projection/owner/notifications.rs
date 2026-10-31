//! Lossless wake coalescing: bounded paths, with a sweep on overflow.
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct Pending {
    pub paths: HashSet<String>,
    pub terminal: bool,
    pub handoffs: bool,
    pub handoff_paths: HashSet<std::path::PathBuf>,
    pub overflow: bool,
}

impl Pending {
    pub(super) fn transcript(&mut self, file: String) -> bool {
        let wake = self.paths.is_empty() && !self.overflow;
        if self.paths.contains(&file) {
            return false;
        }
        if self.paths.len() < super::NOTIFICATION_CAPACITY {
            self.paths.insert(file);
        } else {
            self.overflow = true;
        }
        wake
    }
}

pub(super) fn transcript(
    pending: &std::sync::Arc<parking_lot::Mutex<Pending>>,
    sender: &tokio::sync::mpsc::Sender<super::Command>,
    file: String,
) {
    if pending.lock().transcript(file) {
        // The queued wake is only a hint. Paths and overflow survive channel saturation.
        let _ = sender.try_send(super::Command::Events);
    }
}

pub(super) fn settlement_listener(
    inner: &std::sync::Arc<super::Inner>,
) -> crate::gateway::InboundSettlementListener {
    let owner = std::sync::Arc::downgrade(inner);
    std::sync::Arc::new(move || {
        if let Some(owner) = owner.upgrade() {
            owner.pending.lock().terminal = true;
            let _ = owner.sender.try_send(super::Command::Events);
        }
    })
}

/// E2E fixture builds can drop filesystem wakes to prove settlement alone suffices.
#[cfg(feature = "e2e-fixtures")]
pub(super) fn observe_filesystem() -> bool {
    !(std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_E2E_DISABLE_PROJECTION_WATCH").as_deref() == Ok("1"))
}

#[cfg(not(feature = "e2e-fixtures"))]
pub(super) fn observe_filesystem() -> bool {
    true
}

pub(super) fn handoff_events(
    context: &super::ProjectionContext,
    pending: &std::sync::Arc<parking_lot::Mutex<Pending>>,
    sender: &tokio::sync::mpsc::Sender<super::Command>,
) -> Box<dyn crate::gateway::EventSubscription> {
    let pending = pending.clone();
    let sender = sender.clone();
    context
        .subscribers
        .subscribe(std::sync::Arc::new(move |event| {
            if matches!(
                event.envelope().event_type.as_str(),
                "turn.state_changed"
                    | "session.permanently_deleted"
                    | "project.deleted"
                    | "project.permanently_deleted"
            ) {
                pending.lock().handoffs = true;
                let _ = sender.try_send(super::Command::Events);
            }
        }))
}
