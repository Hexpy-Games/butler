//! App progress publication from committed BTCC facts through the native transcript.

use std::{collections::HashSet, sync::Arc};

use serde_json::Value;
use tokio::sync::Mutex;

use butler_gateway::gateway::TranscriptWriter;
use butler_turn::btcc::{
    BtccError, CommittedProgressEvent, EventVisibility, StorageProgressPublication,
    SubsessionService,
};

mod payload;

const PAGE_SIZE: usize = 32;

/// One App action with its delivery receipt and transcript metadata.
pub(crate) type OutboundRecord = (Value, Value, Value);

pub(crate) struct ProgressPublisher {
    repository: StorageProgressPublication,
    writer: Arc<TranscriptWriter>,
    subsessions: Arc<SubsessionService>,
    /// One pass at a time: a pass appends every event it read before the next
    /// pass reads the store, so the periodic pass and a delivery's flush never
    /// append an event twice or out of source order.
    pass: Mutex<()>,
}

pub(crate) struct ProgressPublicationSummary {
    pub attempted: usize,
    pub published: usize,
}

/// Why a delivered action did not reach the transcript.
pub(crate) enum DeliveryFailure {
    /// Committed progress could not be read.
    Progress(BtccError),
    /// The transcript write or its sync failed.
    Transcript { code: &'static str, message: String },
}

/// The session whose newest pending page shares the action's append.
struct Trailing<'a> {
    session_id: &'a str,
    action: OutboundRecord,
}

struct Pass {
    summary: ProgressPublicationSummary,
    blocked: HashSet<String>,
}

impl ProgressPublisher {
    pub(crate) fn new(
        repository: StorageProgressPublication,
        writer: Arc<TranscriptWriter>,
        subsessions: Arc<SubsessionService>,
    ) -> Self {
        Self {
            repository,
            writer,
            subsessions,
            pass: Mutex::new(()),
        }
    }

    pub(crate) fn subscribe_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.repository.subscribe_changes()
    }

    /// Published events precede anything appended after this pass returns.
    pub(crate) async fn reconcile(&self) -> Result<ProgressPublicationSummary, BtccError> {
        let _pass = self.pass.lock().await;
        let (pass, _) = self.publish_pending(None).await?;
        Ok(pass.summary)
    }

    /// Publishes committed progress, then `action` after `session_id`'s
    /// progress. That session's last pending page and the action share one
    /// write and one sync, which precede marking that progress published and
    /// the caller's acknowledgement.
    pub(crate) async fn publish_with_action(
        &self,
        session_id: &str,
        action: OutboundRecord,
    ) -> Result<(), DeliveryFailure> {
        let _pass = self.pass.lock().await;
        let trailing = Trailing { session_id, action };
        let (_, appended) = self
            .publish_pending(Some(trailing))
            .await
            .map_err(DeliveryFailure::Progress)?;
        appended
    }

    /// Each page releases its hydrated events before the next SQLite read.
    /// A failed event holds its session's later events; other sessions proceed.
    /// Session-first keysets keep concurrent inserts behind that session's
    /// cursor, so the trailing session's newest page is its last once a
    /// later session or the end follows.
    async fn publish_pending(
        &self,
        trailing: Option<Trailing<'_>>,
    ) -> Result<(Pass, Result<(), DeliveryFailure>), BtccError> {
        let mut pass = Pass {
            summary: ProgressPublicationSummary {
                attempted: 0,
                published: 0,
            },
            blocked: HashSet::new(),
        };
        let target = trailing.as_ref().map(|value| value.session_id);
        let mut held: Option<Vec<CommittedProgressEvent>> = None;
        let mut after = None;
        loop {
            let page = self
                .repository
                .pending_page(after.clone(), PAGE_SIZE)
                .await
                .map_err(BtccError::from)?;
            let page_len = page.len();
            after = page
                .last()
                .map(|event| (event.session_id.clone(), event.session_sequence));
            for events in by_session(page) {
                let session = events[0].session_id.clone();
                if pass.blocked.contains(&session) {
                    continue;
                }
                if target != Some(session.as_str()) {
                    let _ = self.publish_session(&session, &events, None, &mut pass).await;
                } else if let Some(previous) = held.replace(events) {
                    // A later page of the trailing session follows this one.
                    let _ = self.publish_session(&session, &previous, None, &mut pass).await;
                    if pass.blocked.contains(&session) {
                        held = None;
                    }
                }
            }
            if page_len < PAGE_SIZE {
                break;
            }
        }
        let Some(Trailing { session_id, action }) = trailing else {
            return Ok((pass, Ok(())));
        };
        let events = held.unwrap_or_default();
        let appended = self
            .publish_session(session_id, &events, Some(action), &mut pass)
            .await;
        Ok((pass, appended))
    }

    // Child transcripts are read directly from BTCC, rather than projected as
    // App chats. Publish their canonical-view invalidation after durable progress.
    async fn invalidate_child(&self, event: &CommittedProgressEvent) -> Result<(), BtccError> {
        if event.event.visibility != Some(EventVisibility::Internal) {
            self.subsessions
                .notify_execution_changed(&event.session_id)
                .await?;
        }
        Ok(())
    }

    /// Appends the prepared prefix of `events`, then `action`, in one write.
    /// A session with a failed or unacknowledged event is blocked for the pass.
    async fn publish_session(
        &self,
        session_id: &str,
        events: &[CommittedProgressEvent],
        action: Option<OutboundRecord>,
        pass: &mut Pass,
    ) -> Result<(), DeliveryFailure> {
        let mut deliveries = Vec::new();
        for event in events {
            pass.summary.attempted += 1;
            let Ok(delivery) = payload::prepare(event) else {
                break;
            };
            deliveries.push(delivery);
        }
        let prepared = deliveries.len();
        if prepared < events.len() {
            pass.blocked.insert(session_id.to_owned());
        }
        let session = session_id.to_owned();
        let appended = match action {
            Some(action) => {
                deliveries.push(action);
                self.writer.append_delivery(session, deliveries).await
            }
            None if prepared == 0 => return Ok(()),
            None => self.writer.append_outbound_batch(session, deliveries).await,
        }
        .map_err(|error| DeliveryFailure::Transcript {
            code: error.code(),
            message: error.message(),
        });
        if appended.is_err() {
            pass.blocked.insert(session_id.to_owned());
            return appended;
        }
        // Acknowledge only the durable, successfully invalidated prefix. A
        // failed suffix remains pending; stable action IDs make replay safe.
        let mut acknowledged = Vec::new();
        for event in &events[..prepared] {
            if self.invalidate_child(event).await.is_err() {
                break;
            }
            acknowledged.push(event.event_id.clone());
        }
        let published = acknowledged.len();
        if self
            .repository
            .mark_published_batch(acknowledged)
            .await
            .is_err()
        {
            pass.blocked.insert(session_id.to_owned());
            return appended;
        }
        pass.summary.published += published;
        if published < events.len() {
            pass.blocked.insert(session_id.to_owned());
        }
        appended
    }
}

/// Splits a session-ordered page into one owned run per session.
fn by_session(page: Vec<CommittedProgressEvent>) -> Vec<Vec<CommittedProgressEvent>> {
    let mut runs: Vec<Vec<CommittedProgressEvent>> = Vec::new();
    for event in page {
        match runs.last_mut() {
            Some(run) if run[0].session_id == event.session_id => run.push(event),
            _ => runs.push(vec![event]),
        }
    }
    runs
}
