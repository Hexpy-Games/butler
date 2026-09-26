//! Source-compatible KnowHow persistence and quality-index owner.

mod entries;
mod index;
mod operator;
mod quality;
mod revision;

#[cfg(test)]
#[path = "knowhow_store/tests.rs"]
mod tests;

use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult, FeedbackTarget},
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

use super::mutable_paths;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct KnowHowAggregateReport {
    pub source_quality_summary_count: usize,
    pub knowhow_indexed_count: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct KnowHowRevisionReport {
    pub revised_knowhow_count: usize,
    pub demoted_knowhow_count: usize,
    pub applied_feedback_count: usize,
}

pub(crate) type FeedbackResolveFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<()>> + Send + 'a>>;

pub(crate) trait FeedbackResolvePort: Send + Sync {
    fn resolve_applied<'a>(&'a self, feedback_id: &'a str) -> FeedbackResolveFuture<'a>;
}

pub(crate) struct KnowHowService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl KnowHowService {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
        }
    }

    pub(crate) async fn aggregate_and_rebuild(&self) -> CognitionResult<KnowHowAggregateReport> {
        self.with_lease("knowhow_aggregation", |root| {
            let quality = quality::aggregate(&root)?;
            let indexed = index::rebuild(&root, &quality)?;
            Ok(KnowHowAggregateReport {
                source_quality_summary_count: quality.len(),
                knowhow_indexed_count: indexed,
            })
        })
        .await
    }

    pub(crate) async fn count_entries(&self) -> CognitionResult<usize> {
        self.with_lease("knowhow_count", |root| entries::count_files(&root))
            .await
    }

    pub(crate) async fn revise(
        &self,
        active_feedback: &[FeedbackTarget],
        resolve: &dyn FeedbackResolvePort,
    ) -> CognitionResult<KnowHowRevisionReport> {
        let active_feedback = active_feedback.to_vec();
        let snapshot = self
            .with_lease("knowhow_revision_snapshot", |root| {
                Ok(revision::Snapshot {
                    entries: entries::list_paths(&root)?,
                    quality_by_source: {
                        let summaries = quality::aggregate(&root)?;
                        quality::quality_score_map(&summaries)
                    },
                })
            })
            .await?;
        let mut report = KnowHowRevisionReport::default();

        for entry_path in snapshot.entries {
            let entry = self
                .with_lease("knowhow_entry_read", move |root| {
                    entries::read_one(&root, &entry_path)
                })
                .await?;
            let targeted = revision::targeted_feedback(&entry, &active_feedback)?;
            let mut next = if targeted.is_empty() {
                entry.clone()
            } else {
                revision::revise_from_feedback(&entry, &targeted)?
            };
            for target in &targeted {
                resolve.resolve_applied(&target.feedback_id).await?;
                report.applied_feedback_count += 1;
            }
            if revision::demote_for_source_quality(&mut next, &snapshot.quality_by_source)? {
                report.demoted_knowhow_count += 1;
            }
            if next != entry {
                self.with_lease("knowhow_entry_write", move |root| {
                    entries::write(&root, &next)
                })
                .await?;
                report.revised_knowhow_count += 1;
            }
        }
        Ok(report)
    }

    async fn with_lease<T, F>(&self, purpose: &'static str, operation: F) -> CognitionResult<T>
    where
        T: Send + 'static,
        F: FnOnce(PathBuf) -> CognitionResult<T> + Send + 'static,
    {
        let cognition_root = self.paths.cognition_root(&self.data_root);
        let root = cognition_root.join("know-how");
        let lock_path = self.paths.consolidation_lock(&self.data_root);
        mutable_paths::ensure_data_authority(
            &self.data_root,
            &[&cognition_root, &root, &lock_path],
        )?;
        let coordinator = self.coordinator.clone();
        let lease = coordinator
            .acquire(
                CognitionWriteAcquire::immediate(lock_path, purpose),
                CognitionWaitClass::Background,
            )
            .await
            .map_err(|failure| CognitionError::new(failure.code, failure.message))?
            .ok_or_else(|| error("memory_write_busy"))?;
        tokio::task::spawn_blocking(move || {
            let result = operation(root);
            let released = lease
                .release(result.is_ok())
                .map_err(|failure| CognitionError::new(failure.code, failure.message));
            match (result, released) {
                (Err(error), _) => Err(error),
                (Ok(_), Err(error)) => Err(error),
                (Ok(value), Ok(())) => Ok(value),
            }
        })
        .await
        .map_err(|_| error("memory_knowhow_io_failed"))?
    }
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, "KnowHow operation failed")
}
