//! Read-only integrity counts for the source legacy metadata.sqlite contract.

mod inspect;

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use rusqlite::{Connection, OpenFlags, params};
use tokio::sync::mpsc;

use crate::cognition::box_store::BoxStoreService;
use crate::cognition::mutable_paths::ensure_data_authority;
use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, FeedbackBufferService,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator};

const SOURCE_CHUNK_LIMIT: usize = 10_000;
const PAGE_SIZE: usize = 100;

use crate::cognition::CognitionCode;
pub(crate) use inspect::LegacyMemoryChunkWithRefs;
use inspect::read_chunk_with_refs;

/// Checks and repairs the links of the legacy memory metadata database.
pub struct LegacyMetadataIntegrityService {
    data_root: PathBuf,
    path: PathBuf,
    paths: CognitionPathEnvironment,
    box_store: Arc<BoxStoreService>,
    feedback: Arc<FeedbackBufferService>,
}

#[derive(Debug, Default)]
pub struct LegacyMetadataIntegrityCounts {
    pub chunk_count: usize,
    pub missing_box_refs_count: usize,
    pub missing_feedback_refs_count: usize,
}

pub struct LegacyMetadataIntegrityReport {
    pub chunk_count: usize,
    pub missing_box_refs: Vec<MissingBoxRef>,
    pub missing_feedback_refs: Vec<MissingFeedbackRef>,
}

/// A chunk link to a box item that no longer exists.
pub struct MissingBoxRef {
    /// Chunk with the link.
    pub memory_chunk_id: String,
    /// Missing box item.
    pub box_item_id: String,
}

/// A chunk link to feedback that no longer exists.
pub struct MissingFeedbackRef {
    /// Chunk with the link.
    pub memory_chunk_id: String,
    /// Missing feedback.
    pub feedback_id: String,
}

pub struct LegacyMetadataRepairReport {
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
    /// An integrity service over the legacy metadata database.
    pub fn new(
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

    /// A chunk with every reference that points at it.
    pub async fn inspect(
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
        .map_err(|source| metadata_error().with_source(source))?
    }

    /// Counts the chunks and their broken links.
    pub async fn check(&self) -> CognitionResult<LegacyMetadataIntegrityCounts> {
        Ok(self.check_inner(References::Counted).await?.counts)
    }

    /// Removes the chunk links to missing box items and feedback, then
    /// re-checks.
    pub async fn repair_links(
        &self,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> CognitionResult<LegacyMetadataRepairReport> {
        let before = self.check_with_references().await?;
        let mut repaired_box_refs = 0;
        let mut repaired_feedback_refs = 0;
        if (!before.missing_box_refs.is_empty() || !before.missing_feedback_refs.is_empty())
            && self
                .path
                .try_exists()
                .map_err(|source| metadata_error().with_source(source))?
        {
            (repaired_box_refs, repaired_feedback_refs) = self
                .remove_links(
                    &coordinator,
                    before.missing_box_refs,
                    before.missing_feedback_refs,
                )
                .await?;
        }
        let integrity = self.check_with_references().await?;
        Ok(LegacyMetadataRepairReport {
            integrity,
            repaired_box_refs,
            repaired_feedback_refs,
        })
    }

    /// Removes the missing links under the consolidation lock; how many box
    /// and feedback links were removed.
    async fn remove_links(
        &self,
        coordinator: &CognitionWriteCoordinator,
        boxes: Vec<MissingBoxRef>,
        feedback: Vec<MissingFeedbackRef>,
    ) -> CognitionResult<(usize, usize)> {
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
            .map_err(CognitionError::from)?
            .ok_or_else(|| {
                CognitionError::new(CognitionCode::MemoryWriteBusy, "memory_write_busy")
            })?;
        let data_root = self.data_root.clone();
        let path = self.path.clone();
        let descriptor = self
            .paths
            .memory_root(&self.data_root)
            .join("active-generation.json");
        tokio::task::spawn_blocking(move || {
            let result = (|| {
                lease.assert_for_path(&lock_path).map_err(|source| {
                    CognitionError::new(CognitionCode::MemoryWriteBusy, "memory_write_busy")
                        .with_source(source)
                })?;
                remove_missing_links(&data_root, &path, &descriptor, &boxes, &feedback)
            })();
            let released = lease.release(result.is_ok()).map_err(CognitionError::from);
            match (result, released) {
                (Err(failure), _) | (Ok(_), Err(failure)) => Err(failure),
                (Ok(value), Ok(())) => Ok(value),
            }
        })
        .await
        .map_err(|source| metadata_error().with_source(source))?
    }

    /// Lists the broken links.
    pub async fn check_with_references(&self) -> CognitionResult<LegacyMetadataIntegrityReport> {
        let integrity = self.check_inner(References::Listed).await?;
        Ok(LegacyMetadataIntegrityReport {
            chunk_count: integrity.counts.chunk_count,
            missing_box_refs: integrity.missing_box_refs,
            missing_feedback_refs: integrity.missing_feedback_refs,
        })
    }

    /// Streams every chunk's references and checks them against the box
    /// store and the feedback buffer.
    async fn check_inner(&self, references: References) -> CognitionResult<Integrity> {
        ensure_data_authority(&self.data_root, &[&self.path])?;
        let mut integrity = Integrity {
            references,
            counts: LegacyMetadataIntegrityCounts::default(),
            missing_box_refs: Vec::new(),
            missing_feedback_refs: Vec::new(),
        };
        if !self
            .path
            .try_exists()
            .map_err(|source| metadata_error().with_source(source))?
        {
            return Ok(integrity);
        }
        let (sender, mut receiver) = mpsc::channel(1);
        let path = self.path.clone();
        let producer = tokio::task::spawn_blocking(move || stream_refs(&path, &sender));
        let mut outcome = Ok(());
        while let Some(batch) = receiver.recv().await {
            outcome = match batch {
                Ok(batch) => self.check_batch(&mut integrity, batch).await,
                Err(error) => Err(error),
            };
            if outcome.is_err() {
                break;
            }
        }
        drop(receiver);
        let producer_result = producer
            .await
            .map_err(|source| metadata_error().with_source(source))?;
        outcome?;
        producer_result?;
        Ok(integrity)
    }

    async fn check_batch(
        &self,
        integrity: &mut Integrity,
        batch: Vec<ChunkRefs>,
    ) -> CognitionResult<()> {
        integrity.counts.chunk_count += batch.len();
        let requested = batch
            .iter()
            .flat_map(|chunk| chunk.feedback_ids.iter().cloned())
            .collect::<HashSet<_>>();
        let found = self.feedback.matching_ids(requested).await?;
        for chunk in batch {
            for id in chunk.box_ids {
                if !self.box_store.manifest_exists(&id).await? {
                    integrity.missing_box(&chunk.memory_chunk_id, id);
                }
            }
            for id in chunk.feedback_ids {
                if !found.contains(&id) {
                    integrity.missing_feedback(&chunk.memory_chunk_id, id);
                }
            }
        }
        Ok(())
    }
}

/// Whether a check lists the missing references or only counts them.
#[derive(Clone, Copy, PartialEq, Eq)]
enum References {
    Counted,
    Listed,
}

/// What a metadata check found.
struct Integrity {
    references: References,
    counts: LegacyMetadataIntegrityCounts,
    missing_box_refs: Vec<MissingBoxRef>,
    missing_feedback_refs: Vec<MissingFeedbackRef>,
}

impl Integrity {
    fn missing_box(&mut self, memory_chunk_id: &str, box_item_id: String) {
        self.counts.missing_box_refs_count += 1;
        if self.references == References::Listed {
            self.missing_box_refs.push(MissingBoxRef {
                memory_chunk_id: memory_chunk_id.to_owned(),
                box_item_id,
            });
        }
    }

    fn missing_feedback(&mut self, memory_chunk_id: &str, feedback_id: String) {
        self.counts.missing_feedback_refs_count += 1;
        if self.references == References::Listed {
            self.missing_feedback_refs.push(MissingFeedbackRef {
                memory_chunk_id: memory_chunk_id.to_owned(),
                feedback_id,
            });
        }
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
        .map_err(|source| metadata_error().with_source(source))?
    {
        return Err(CognitionError::new(
            CognitionCode::LegacyMemoryWriterDisabledForV2,
            "legacy_memory_writer_disabled_for_v2",
        ));
    }
    let mut db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|source| metadata_error().with_source(source))?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|source| metadata_error().with_source(source))?;
    let transaction = db
        .transaction()
        .map_err(|source| metadata_error().with_source(source))?;
    let mut repaired_box_refs = 0;
    let mut repaired_feedback_refs = 0;
    for reference in boxes {
        repaired_box_refs += transaction
            .execute(
                "DELETE FROM memory_chunk_box_refs WHERE memory_chunk_id=?1 AND box_item_id=?2",
                params![reference.memory_chunk_id, reference.box_item_id],
            )
            .map_err(|source| metadata_error().with_source(source))?;
    }
    for reference in feedback {
        repaired_feedback_refs += transaction.execute(
            "DELETE FROM memory_chunk_feedback_refs WHERE memory_chunk_id=?1 AND feedback_id=?2",
            params![reference.memory_chunk_id, reference.feedback_id],
        )
        .map_err(|source| metadata_error().with_source(source))?;
    }
    transaction
        .commit()
        .map_err(|source| metadata_error().with_source(source))?;
    Ok((repaired_box_refs, repaired_feedback_refs))
}

fn stream_refs(
    path: &PathBuf,
    sender: &mpsc::Sender<CognitionResult<Vec<ChunkRefs>>>,
) -> CognitionResult<()> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|source| metadata_error().with_source(source))?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|source| metadata_error().with_source(source))?;
    let mut chunk_query = db
        .prepare("SELECT memory_chunk_id FROM memory_chunks ORDER BY updated_at DESC, memory_chunk_id DESC LIMIT ?1 OFFSET ?2")
        .map_err(|source| metadata_error().with_source(source))?;
    let mut box_query = db
        .prepare("SELECT box_item_id FROM memory_chunk_box_refs WHERE memory_chunk_id=?1 ORDER BY box_item_id,relation")
        .map_err(|source| metadata_error().with_source(source))?;
    let mut feedback_query = db
        .prepare("SELECT feedback_id FROM memory_chunk_feedback_refs WHERE memory_chunk_id=?1 ORDER BY feedback_id,relation")
        .map_err(|source| metadata_error().with_source(source))?;
    for offset in (0..SOURCE_CHUNK_LIMIT).step_by(PAGE_SIZE) {
        let ids = chunk_query
            .query_map(
                params![
                    i64::try_from(PAGE_SIZE).unwrap_or(i64::MAX),
                    i64::try_from(offset).unwrap_or(i64::MAX)
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|source| metadata_error().with_source(source))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|source| metadata_error().with_source(source))?;
        if ids.is_empty() {
            break;
        }
        let mut batch = Vec::with_capacity(ids.len());
        for id in ids {
            batch.push(ChunkRefs {
                memory_chunk_id: id.clone(),
                box_ids: box_query
                    .query_map([&id], |row| row.get::<_, String>(0))
                    .map_err(|source| metadata_error().with_source(source))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|source| metadata_error().with_source(source))?,
                feedback_ids: feedback_query
                    .query_map([&id], |row| row.get::<_, String>(0))
                    .map_err(|source| metadata_error().with_source(source))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|source| metadata_error().with_source(source))?,
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
        CognitionCode::MemoryMetadataIntegrityFailed,
        "Could not read legacy memory metadata integrity",
    )
}
