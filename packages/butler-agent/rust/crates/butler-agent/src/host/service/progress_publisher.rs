//! App progress publication from committed BTCC facts through the native transcript.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

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
    pass: Mutex<PublicationPass>,
}

#[derive(Default)]
struct PublicationPass {
    staged: HashMap<String, Staged>,
    boundaries: HashSet<String>,
}

#[derive(Clone, Copy)]
struct Staged {
    sequence: u64,
    public: bool,
}

pub(crate) struct ProgressPublicationSummary {
    pub retry_pending: bool,
}

struct StageSummary {
    attempted: usize,
    staged: usize,
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
            pass: Mutex::new(PublicationPass::default()),
        }
    }

    pub(crate) fn subscribe_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.repository.subscribe_changes()
    }

    /// Each page releases its hydrated events before the next SQLite read.
    /// A failed event holds its session's later events; other sessions proceed.
    /// Session-first keysets keep concurrent inserts behind that session's cursor.
    /// Staged prefixes remain pending at the source until their boundary sync.
    pub(crate) async fn reconcile(&self) -> Result<ProgressPublicationSummary, BtccError> {
        let mut pass = self.pass.lock().await;
        let summary = self.stage(&mut pass.staged, None).await?;
        let mut retry_pending = summary.attempted != summary.staged;
        for session in pass.boundaries.iter().cloned().collect::<Vec<_>>() {
            retry_pending |= self.finish_boundary(&mut pass, &session).await.is_err();
        }
        Ok(ProgressPublicationSummary { retry_pending })
    }

    async fn stage(
        &self,
        staged: &mut HashMap<String, Staged>,
        target: Option<&str>,
    ) -> Result<StageSummary, BtccError> {
        let mut summary = StageSummary {
            attempted: 0,
            staged: 0,
        };
        let mut after = target.map(|session| {
            (
                session.to_owned(),
                staged.get(session).map_or(0, |prefix| prefix.sequence),
            )
        });
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
                if target.is_some_and(|target| target != session) {
                    return Ok(summary);
                }
                if blocked.contains(session) {
                    continue;
                }
                let events = events
                    .split_at(events.partition_point(|event| {
                        staged
                            .get(session)
                            .is_some_and(|sequence| event.session_sequence <= sequence.sequence)
                    }))
                    .1;
                if events.is_empty() {
                    continue;
                }
                let (attempted, published) = self.publish_session(events).await;
                if published > 0 {
                    let public = events[..published]
                        .iter()
                        .any(|event| event.event.visibility != Some(EventVisibility::Internal));
                    let entry = staged.entry(session.clone()).or_insert(Staged {
                        sequence: 0,
                        public: false,
                    });
                    entry.sequence = events[published - 1].session_sequence;
                    entry.public |= public;
                }
                summary.attempted += attempted;
                summary.staged += published;
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

    /// Recovery and shutdown must publish any tail without a live execution.
    pub(crate) async fn flush_all(&self) -> Result<(), BtccError> {
        let mut pass = self.pass.lock().await;
        let summary = self.stage(&mut pass.staged, None).await?;
        if summary.attempted != summary.staged {
            return Err(BtccError::relayed(
                "native_progress_publication_failed",
                "Committed progress could not be staged",
            ));
        }
        let sessions: Vec<_> = pass.staged.keys().cloned().collect();
        pass.boundaries.extend(sessions);
        for session in pass.boundaries.iter().cloned().collect::<Vec<_>>() {
            self.finish_boundary(&mut pass, &session).await?;
        }
        Ok(())
    }

    pub(crate) async fn flush(&self, session: String) -> Result<(), BtccError> {
        let mut pass = self.pass.lock().await;
        let summary = self.stage(&mut pass.staged, Some(&session)).await?;
        if summary.attempted != summary.staged {
            return Err(BtccError::relayed(
                "native_progress_publication_failed",
                "Committed progress could not be staged",
            ));
        }
        pass.boundaries.insert(session.clone());
        self.finish_boundary(&mut pass, &session).await
    }

    pub(crate) async fn deliver(
        &self,
        session: String,
        action: serde_json::Value,
        delivery: serde_json::Value,
        metadata: serde_json::Value,
    ) -> Result<(), BtccError> {
        let mut pass = self.pass.lock().await;
        let summary = self.stage(&mut pass.staged, Some(&session)).await?;
        if summary.attempted != summary.staged {
            return Err(BtccError::relayed(
                "native_progress_publication_failed",
                "Committed progress could not be staged",
            ));
        }
        pass.boundaries.insert(session.clone());
        self.writer
            .append_outbound(session.clone(), action, delivery, metadata)
            .await
            .map_err(|error| BtccError::relayed(error.code(), error.message()))?;
        self.acknowledge(&mut pass.staged, &session).await?;
        pass.boundaries.remove(&session);
        Ok(())
    }

    async fn finish_boundary(
        &self,
        pass: &mut PublicationPass,
        session: &str,
    ) -> Result<(), BtccError> {
        self.writer
            .sync_session(session.to_owned())
            .await
            .map_err(|error| BtccError::relayed(error.code(), error.message()))?;
        self.acknowledge(&mut pass.staged, session).await?;
        pass.boundaries.remove(session);
        Ok(())
    }

    async fn acknowledge(
        &self,
        staged: &mut HashMap<String, Staged>,
        session: &str,
    ) -> Result<(), BtccError> {
        let Some(prefix) = staged.get(session).copied() else {
            return Ok(());
        };
        // One invalidation covers the whole synced prefix. Readers still load
        // every canonical child event; internal-only prefixes stay private.
        if prefix.public {
            self.subsessions.notify_execution_changed(session).await?;
        }
        self.repository
            .mark_published_through(session.to_owned(), prefix.sequence)
            .await?;
        staged.remove(session);
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
                .stage_outbound_batch(events[0].session_id.clone(), deliveries)
                .await
                .is_err()
        {
            return (attempted, 0);
        }
        (attempted, prepared)
    }
}
