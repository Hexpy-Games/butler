//! Read-only integrity counts for the source legacy metadata.sqlite contract.

mod inspect;

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use rusqlite::{Connection, OpenFlags, params};
use tokio::sync::mpsc;

use super::{
    CognitionError, CognitionPathEnvironment, CognitionResult, FeedbackBufferService,
    box_store::BoxStoreService, mutable_paths::ensure_data_authority,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};

const SOURCE_CHUNK_LIMIT: usize = 10_000;
const PAGE_SIZE: usize = 100;

pub(crate) use inspect::LegacyMemoryChunkWithRefs;
use inspect::read_chunk_with_refs;

pub(crate) struct LegacyMetadataIntegrityService {
    data_root: PathBuf,
    path: PathBuf,
    paths: CognitionPathEnvironment,
    box_store: Arc<BoxStoreService>,
    feedback: Arc<FeedbackBufferService>,
}

#[derive(Debug, Default)]
pub(crate) struct LegacyMetadataIntegrityCounts {
    pub chunk_count: usize,
    pub missing_box_refs_count: usize,
    pub missing_feedback_refs_count: usize,
}

pub(crate) struct LegacyMetadataIntegrityReport {
    pub chunk_count: usize,
    pub missing_box_refs: Vec<MissingBoxRef>,
    pub missing_feedback_refs: Vec<MissingFeedbackRef>,
}

pub(crate) struct MissingBoxRef {
    pub memory_chunk_id: String,
    pub box_item_id: String,
}

pub(crate) struct MissingFeedbackRef {
    pub memory_chunk_id: String,
    pub feedback_id: String,
}

pub(crate) struct LegacyMetadataRepairReport {
    pub integrity: LegacyMetadataIntegrityReport,
    pub repaired_box_refs: usize,
    pub repaired_feedback_refs: usize,
}

struct ChunkRefs {
    memory_chunk_id: String,
    box_ids: Vec<String>,
    feedback_ids: Vec<String>,
}

impl LegacyMetadataIntegrityService {
    pub(crate) fn new(
        data_root: &Path,
        paths: CognitionPathEnvironment,
        box_store: Arc<BoxStoreService>,
        feedback: Arc<FeedbackBufferService>,
    ) -> Self {
        Self {
            data_root: data_root.to_path_buf(),
            path: paths.memory_root(data_root).join("metadata.sqlite"),
            paths,
            box_store,
            feedback,
        }
    }

    pub(crate) async fn inspect(
        &self,
        memory_chunk_id: &str,
    ) -> CognitionResult<Option<LegacyMemoryChunkWithRefs>> {
        let data_root = self.data_root.clone();
        let path = self.path.clone();
        let memory_chunk_id = memory_chunk_id.to_owned();
        tokio::task::spawn_blocking(move || {
            ensure_data_authority(&data_root, &[&path])?;
            read_chunk_with_refs(&data_root, &path, &memory_chunk_id)
        })
        .await
        .map_err(|_| metadata_error())?
    }

    pub(crate) async fn check(&self) -> CognitionResult<LegacyMetadataIntegrityCounts> {
        let (counts, _, _) = self.check_inner(false).await?;
        Ok(counts)
    }

    pub(crate) async fn repair_links(
        &self,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> CognitionResult<LegacyMetadataRepairReport> {
        let before = self.check_with_references().await?;
        let planned_box_refs = before.missing_box_refs.len();
        let planned_feedback_refs = before.missing_feedback_refs.len();
        let mut repaired_box_refs = 0;
        let mut repaired_feedback_refs = 0;
        if (planned_box_refs > 0 || planned_feedback_refs > 0)
            && self.path.try_exists().map_err(|_| metadata_error())?
        {
            let lock_path = self.paths.consolidation_lock(&self.data_root);
            ensure_data_authority(
                &self.data_root,
                &[
                    &self.path,
                    &lock_path,
                    &self.paths.memory_root(&self.data_root),
                ],
            )?;
            let lease = coordinator
                .acquire(
                    CognitionWriteAcquire::immediate(lock_path.clone(), "memory-metadata-repair"),
                    CognitionWaitClass::Interactive,
                )
                .await
                .map_err(|failure| CognitionError::new(failure.code, failure.message))?
                .ok_or_else(|| CognitionError::new("memory_write_busy", "memory_write_busy"))?;
            let data_root = self.data_root.clone();
            let path = self.path.clone();
            let descriptor = self
                .paths
                .memory_root(&self.data_root)
                .join("active-generation.json");
            let boxes = before.missing_box_refs;
            let feedback = before.missing_feedback_refs;
            let result = tokio::task::spawn_blocking(move || {
                let result = (|| {
                    lease.assert_for_path(&lock_path).map_err(|_| {
                        CognitionError::new("memory_write_busy", "memory_write_busy")
                    })?;
                    remove_missing_links(&data_root, &path, &descriptor, &boxes, &feedback)
                })();
                let released = lease
                    .release(result.is_ok())
                    .map_err(|failure| CognitionError::new(failure.code, failure.message));
                match (result, released) {
                    (Err(failure), _) | (Ok(_), Err(failure)) => Err(failure),
                    (Ok(value), Ok(())) => Ok(value),
                }
            })
            .await
            .map_err(|_| metadata_error())?;
            (repaired_box_refs, repaired_feedback_refs) = result?;
        }
        let integrity = self.check_with_references().await?;
        Ok(LegacyMetadataRepairReport {
            integrity,
            repaired_box_refs,
            repaired_feedback_refs,
        })
    }

    pub(crate) async fn check_with_references(
        &self,
    ) -> CognitionResult<LegacyMetadataIntegrityReport> {
        let (counts, missing_box_refs, missing_feedback_refs) = self.check_inner(true).await?;
        Ok(LegacyMetadataIntegrityReport {
            chunk_count: counts.chunk_count,
            missing_box_refs,
            missing_feedback_refs,
        })
    }

    async fn check_inner(
        &self,
        include_references: bool,
    ) -> CognitionResult<(
        LegacyMetadataIntegrityCounts,
        Vec<MissingBoxRef>,
        Vec<MissingFeedbackRef>,
    )> {
        ensure_data_authority(&self.data_root, &[&self.path])?;
        if !self.path.try_exists().map_err(|_| metadata_error())? {
            return Ok((
                LegacyMetadataIntegrityCounts::default(),
                Vec::new(),
                Vec::new(),
            ));
        }
        let (sender, mut receiver) = mpsc::channel(1);
        let path = self.path.clone();
        let producer = tokio::task::spawn_blocking(move || stream_refs(&path, &sender));
        let mut counts = LegacyMetadataIntegrityCounts::default();
        let mut missing_box_refs = Vec::new();
        let mut missing_feedback_refs = Vec::new();
        let mut outcome = Ok(());
        while let Some(batch) = receiver.recv().await {
            let batch = match batch {
                Ok(batch) => batch,
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            };
            counts.chunk_count += batch.len();
            let requested = batch
                .iter()
                .flat_map(|chunk| chunk.feedback_ids.iter().cloned())
                .collect::<HashSet<_>>();
            let found = match self.feedback.matching_ids(requested).await {
                Ok(found) => found,
                Err(error) => {
                    outcome = Err(error);
                    break;
                }
            };
            for chunk in batch {
                for id in chunk.box_ids {
                    match self.box_store.manifest_exists(&id).await {
                        Ok(true) => {}
                        Ok(false) => {
                            counts.missing_box_refs_count += 1;
                            if include_references {
                                missing_box_refs.push(MissingBoxRef {
                                    memory_chunk_id: chunk.memory_chunk_id.clone(),
                                    box_item_id: id,
                                });
                            }
                        }
                        Err(error) => {
                            outcome = Err(error);
                            break;
                        }
                    }
                }
                if outcome.is_err() {
                    break;
                }
                for id in chunk.feedback_ids {
                    if !found.contains(&id) {
                        counts.missing_feedback_refs_count += 1;
                        if include_references {
                            missing_feedback_refs.push(MissingFeedbackRef {
                                memory_chunk_id: chunk.memory_chunk_id.clone(),
                                feedback_id: id,
                            });
                        }
                    }
                }
            }
            if outcome.is_err() {
                break;
            }
        }
        drop(receiver);
        let producer_result = producer.await.map_err(|_| metadata_error())?;
        outcome?;
        producer_result?;
        Ok((counts, missing_box_refs, missing_feedback_refs))
    }
}

fn remove_missing_links(
    data_root: &std::path::Path,
    path: &std::path::Path,
    active_descriptor: &std::path::Path,
    boxes: &[MissingBoxRef],
    feedback: &[MissingFeedbackRef],
) -> CognitionResult<(usize, usize)> {
    ensure_data_authority(data_root, &[path, active_descriptor])?;
    if active_descriptor
        .try_exists()
        .map_err(|_| metadata_error())?
    {
        return Err(CognitionError::new(
            "legacy_memory_writer_disabled_for_v2",
            "legacy_memory_writer_disabled_for_v2",
        ));
    }
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| metadata_error())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| metadata_error())?;
    let transaction = db.transaction().map_err(|_| metadata_error())?;
    let mut repaired_box_refs = 0;
    let mut repaired_feedback_refs = 0;
    for reference in boxes {
        repaired_box_refs += transaction
            .execute(
                "DELETE FROM memory_chunk_box_refs WHERE memory_chunk_id=?1 AND box_item_id=?2",
                params![reference.memory_chunk_id, reference.box_item_id],
            )
            .map_err(|_| metadata_error())?;
    }
    for reference in feedback {
        repaired_feedback_refs += transaction.execute(
            "DELETE FROM memory_chunk_feedback_refs WHERE memory_chunk_id=?1 AND feedback_id=?2",
            params![reference.memory_chunk_id, reference.feedback_id],
        )
        .map_err(|_| metadata_error())?;
    }
    transaction.commit().map_err(|_| metadata_error())?;
    Ok((repaired_box_refs, repaired_feedback_refs))
}

fn stream_refs(
    path: &PathBuf,
    sender: &mpsc::Sender<CognitionResult<Vec<ChunkRefs>>>,
) -> CognitionResult<()> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| metadata_error())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| metadata_error())?;
    let mut chunk_query = db
        .prepare("SELECT memory_chunk_id FROM memory_chunks ORDER BY updated_at DESC, memory_chunk_id DESC LIMIT ?1 OFFSET ?2")
        .map_err(|_| metadata_error())?;
    let mut box_query = db
        .prepare("SELECT box_item_id FROM memory_chunk_box_refs WHERE memory_chunk_id=?1 ORDER BY box_item_id,relation")
        .map_err(|_| metadata_error())?;
    let mut feedback_query = db
        .prepare("SELECT feedback_id FROM memory_chunk_feedback_refs WHERE memory_chunk_id=?1 ORDER BY feedback_id,relation")
        .map_err(|_| metadata_error())?;
    for offset in (0..SOURCE_CHUNK_LIMIT).step_by(PAGE_SIZE) {
        let ids = chunk_query
            .query_map(
                params![
                    i64::try_from(PAGE_SIZE).unwrap_or(i64::MAX),
                    i64::try_from(offset).unwrap_or(i64::MAX)
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| metadata_error())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| metadata_error())?;
        if ids.is_empty() {
            break;
        }
        let mut batch = Vec::with_capacity(ids.len());
        for id in ids {
            batch.push(ChunkRefs {
                memory_chunk_id: id.clone(),
                box_ids: box_query
                    .query_map([&id], |row| row.get::<_, String>(0))
                    .map_err(|_| metadata_error())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| metadata_error())?,
                feedback_ids: feedback_query
                    .query_map([&id], |row| row.get::<_, String>(0))
                    .map_err(|_| metadata_error())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| metadata_error())?,
            });
        }
        if sender.blocking_send(Ok(batch)).is_err() {
            break;
        }
    }
    Ok(())
}

fn metadata_error() -> CognitionError {
    CognitionError::new(
        "memory_metadata_integrity_failed",
        "Could not read legacy memory metadata integrity",
    )
}
