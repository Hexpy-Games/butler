//! The idle poll's read side: one long-lived read-only graph connection that
//! answers "is there work?" without opening the database or taking the write
//! lease on every tick.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

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
    fn with<T>(
        &self,
        path: &Path,
        read: impl FnOnce(&GraphRepository) -> CognitionResult<T>,
    ) -> CognitionResult<T> {
        let mut open = self.open.lock();
        let graph = match open.take() {
            Some((opened, graph)) if opened == path => graph,
            Some(_) | None => GraphRepository::open_readonly(path)?,
        };
        let result = read(&graph);
        if result.is_ok() {
            *open = Some((path.to_owned(), graph));
        }
        result
    }

    /// Whether a window is held by an owner that recovery should inspect.
    pub(super) fn recoverable_windows(&self, path: &Path) -> CognitionResult<bool> {
        self.with(path, GraphRepository::has_recoverable_windows)
    }

    /// The next job with a due semantic window.
    pub(super) fn pending_job(
        &self,
        path: &Path,
        now: &str,
    ) -> CognitionResult<Option<PendingSemanticJob>> {
        self.with(path, |graph| graph.pending_semantic_job(now))
    }

    /// Whether a vector claim would find a unit to embed or recover.
    pub(super) fn vector_work(&self, path: &Path, now: &str) -> CognitionResult<bool> {
        self.with(path, |graph| graph.has_vector_work(now))
    }

    pub(super) fn catchup_state(&self, path: &Path) -> CognitionResult<CatchupState> {
        self.with(path, GraphRepository::catchup_state)
    }

    pub(super) fn registered_observations(
        &self,
        path: &Path,
        ids: &[String],
    ) -> CognitionResult<HashSet<String>> {
        self.with(path, |graph| graph.registered_observations(ids))
    }

    /// Closes the connection.
    pub(super) fn close(&self) {
        *self.open.lock() = None;
    }
}
