//! App progress publication from committed BTCC facts through the native transcript.

use std::{collections::HashSet, sync::Arc};

use tokio::sync::Mutex;

use butler_gateway::gateway::TranscriptWriter;
use butler_turn::btcc::{
    BtccError, CommittedProgressEvent, EventVisibility, StorageProgressPublication,
    SubsessionService,
};

mod payload;

const PAGE_SIZE: usize = 32;

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

    /// Each page releases its hydrated events before the next SQLite read.
    /// A failed event holds its session's later events; other sessions proceed.
    /// Session-first keysets keep concurrent inserts behind that session's cursor.
    /// Published events precede anything appended after this pass returns.
    pub(crate) async fn reconcile(&self) -> Result<ProgressPublicationSummary, BtccError> {
        let _pass = self.pass.lock().await;
        let mut summary = ProgressPublicationSummary {
            attempted: 0,
            published: 0,
        };
        let mut after = None;
        let mut blocked = HashSet::new();
        loop {
            let page = self
                .repository
                .pending_page(after.clone(), PAGE_SIZE)
                .await
                .map_err(BtccError::from)?;
            if page.is_empty() {
                break;
            }
            let page_len = page.len();
            after = page
                .last()
                .map(|event| (event.session_id.clone(), event.session_sequence));
            for events in page.chunk_by(|left, right| left.session_id == right.session_id) {
                let session = &events[0].session_id;
                if blocked.contains(session) {
                    continue;
                }
                let (attempted, published) = self.publish_session(events).await;
                summary.attempted += attempted;
                summary.published += published;
                if published < events.len() {
                    blocked.insert(session.clone());
                }
            }
            if page_len < PAGE_SIZE {
                break;
            }
        }
        Ok(summary)
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

    async fn publish_session(&self, events: &[CommittedProgressEvent]) -> (usize, usize) {
        let mut deliveries = Vec::new();
        let mut attempted = 0;
        for event in events {
            attempted += 1;
            let Ok(delivery) = payload::prepare(event) else {
                break;
            };
            deliveries.push(delivery);
        }
        let prepared = deliveries.len();
        if prepared == 0
            || self
                .writer
                .append_outbound_batch(events[0].session_id.clone(), deliveries)
                .await
                .is_err()
        {
            return (attempted, 0);
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
            return (attempted, 0);
        }
        (attempted, published)
    }
}
