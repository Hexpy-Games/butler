//! The idle poll's read side: one long-lived read-only graph connection that
//! answers "is there work?" without opening the database or taking the write
//! lease on every tick.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::cognition::CognitionResult;
use crate::cognition::graph::{CatchupState, GraphRepository, PendingSemanticJob};

/// A read-only connection to the graph of the generation being served. It is
/// reopened when the generation changes and after any read error.
#[derive(Default)]
pub(super) struct ProbeReader {
    open: Mutex<Option<(PathBuf, GraphRepository)>>,
}

impl ProbeReader {
    /// Runs `read` on the connection to the graph at `path`.
    async fn with<T: Send + 'static>(
        self: &Arc<Self>,
        path: &Path,
        read: impl FnOnce(&GraphRepository) -> CognitionResult<T> + Send + 'static,
    ) -> CognitionResult<T> {
        let this = self.clone();
        let path = path.to_owned();
        super::blocking::run(move || {
            let mut open = this.open.lock();
            let graph = match open.take() {
                Some((opened, graph)) if opened == path => graph,
                Some(_) | None => GraphRepository::open_readonly(&path)?,
            };
            let result = read(&graph);
            if result.is_ok() {
                *open = Some((path, graph));
            }
            result
        })
        .await
    }

    /// Whether a window is held by an owner that recovery should inspect.
    pub(super) async fn recoverable_windows(
        self: &Arc<Self>,
        path: &Path,
    ) -> CognitionResult<bool> {
        self.with(path, GraphRepository::has_recoverable_windows)
            .await
    }

    /// The next job with a due semantic window.
    pub(super) async fn pending_job(
        self: &Arc<Self>,
        path: &Path,
        now: &str,
    ) -> CognitionResult<Option<PendingSemanticJob>> {
        let now = now.to_owned();
        self.with(path, move |graph| graph.pending_semantic_job(&now))
            .await
    }

    /// Whether a vector claim would find a unit to embed or recover.
    pub(super) async fn vector_work(
        self: &Arc<Self>,
        path: &Path,
        now: &str,
    ) -> CognitionResult<bool> {
        let now = now.to_owned();
        self.with(path, move |graph| graph.has_vector_work(&now))
            .await
    }

    pub(super) async fn catchup_state(
        self: &Arc<Self>,
        path: &Path,
    ) -> CognitionResult<CatchupState> {
        self.with(path, GraphRepository::catchup_state).await
    }

    pub(super) async fn registered_observations(
        self: &Arc<Self>,
        path: &Path,
        ids: &[String],
    ) -> CognitionResult<HashSet<String>> {
        let ids = ids.to_owned();
        self.with(path, move |graph| graph.registered_observations(&ids))
            .await
    }

    /// Closes the connection.
    pub(super) async fn close(self: &Arc<Self>) -> CognitionResult<()> {
        let this = self.clone();
        super::blocking::run(move || {
            *this.open.lock() = None;
            Ok(())
        })
        .await
    }
}
