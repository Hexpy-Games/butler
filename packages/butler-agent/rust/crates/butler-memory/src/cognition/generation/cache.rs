//! Source-backed hot cache for a separate building generation.
//!
//! [`advance`] claims one pending cache job of the candidate, writes each of
//! its window summaries into `hot/cache.md` through [`format::render`], and
//! records a [`receipt::CacheJobReceipt`]. When nothing is pending it first
//! requeues complete jobs whose retained entries went missing.

mod format;
mod health;
pub(in crate::cognition) mod receipt;
pub(in crate::cognition) use format::{
    Authority, HotCacheEntryView, Salience, Scope, SourceBackedHotCacheEntry, SourceClass,
    SourceKind, physical_entries,
};
pub(in crate::cognition) use health::{HotCacheHealth, read as read_hot_cache_health};

use crate::cognition::CognitionCode;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio_util::sync::CancellationToken;

use crate::cognition::graph::{CacheWindow, ClaimedCacheJob, GraphRepository};
use crate::cognition::sources::read_typed_record;
use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, ConversationSourceNotice,
    MemoryGenerationHandle, MemoryGenerationTarget, assert_conversation_source_current,
    assert_mutation_authority, ensure_data_authority, resolve_generation,
};
use crate::coordination::CognitionWriteCoordinator;
use butler_turn::conversation::ConversationSourceReader;
use receipt::{
    CacheJobReceipt, CacheWriteReceipt, EntryOutcome, ExcludedEntryReceipt, ReceiptScope,
};

/// Advances one cache job of a building candidate. Returns `false` when no
/// job was pending.
pub async fn advance(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<bool> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
    let MemoryGenerationTarget::Rebuild { .. } = target else {
        return Err(error(CognitionCode::MemoryGenerationChanged));
    };
    let handle = resolve_generation(data_root, environment, target)?;
    let lock = environment.consolidation_lock(data_root);
    let cache = handle.root.join("hot/cache.md");
    ensure_data_authority(
        data_root,
        &[
            &lock,
            &handle.root,
            &handle.graph_path,
            &handle.source_root,
            &cache,
            &handle.root.join("hot/cache.md.lock"),
        ],
    )?;
    let lease =
        super::stage::acquire(&coordinator, &lock, "rebuild_hot_cache", cancellation).await?;
    let step = CacheStep {
        data_root: data_root.to_owned(),
        environment: environment.clone(),
        target: target.clone(),
        lock,
        cache,
        cancellation: cancellation.clone(),
    };
    super::stage::leased(
        lease,
        CognitionCode::MemoryCacheOperationFailed,
        move |lease| step.run(lease),
    )
    .await
}

/// The leased cache step.
struct CacheStep {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    target: MemoryGenerationTarget,
    lock: PathBuf,
    cache: PathBuf,
    cancellation: CancellationToken,
}

impl CacheStep {
    fn run(self, lease: &crate::coordination::CognitionWriteLease) -> CognitionResult<bool> {
        lease
            .assert_for_path(&self.lock)
            .map_err(|source| error(CognitionCode::MemoryWriteBusy).with_source(source))?;
        if self.cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        let current = resolve_generation(&self.data_root, &self.environment, &self.target)?;
        assert_mutation_authority(&self.data_root, &self.environment, &self.target, &current)?;
        run_claimed(&self.data_root, &current, &self.cache, &self.cancellation)
    }
}

fn run_claimed(
    data_root: &Path,
    handle: &MemoryGenerationHandle,
    cache: &Path,
    cancellation: &CancellationToken,
) -> CognitionResult<bool> {
    let mut graph = GraphRepository::open(&handle.graph_path)?;
    let now = now();
    let mut job = graph.claim_cache_job(&now)?;
    if job.is_none() {
        // A full retained-cache scan is needed at the quiescent boundary, not
        // before each pending job in a large rebuild.
        reconcile_missing(&mut graph, handle, cache)?;
        job = graph.claim_cache_job(&now)?;
    }
    let Some(job) = job else {
        graph.close()?;
        return Ok(false);
    };
    let writer = JobWriter {
        data_root,
        handle,
        cache,
        job: &job,
        now: &now,
    };
    let produced = if cancellation.is_cancelled() {
        Err(error(CognitionCode::MemoryOperationAborted))
    } else {
        writer.write(&mut graph)
    };
    if let Err(failure) = &produced {
        let code = if failure.code().starts_with("hot_cache_") {
            failure.code()
        } else {
            "hot_cache_io_failed"
        };
        let _ = graph.fail_cache_job(&job, code);
    }
    let closed = graph.close();
    produced.and_then(|()| {
        closed?;
        Ok(true)
    })
}

/// Writes one claimed job's windows and completes it.
struct JobWriter<'a> {
    data_root: &'a Path,
    handle: &'a MemoryGenerationHandle,
    cache: &'a Path,
    job: &'a ClaimedCacheJob,
    now: &'a str,
}

impl JobWriter<'_> {
    fn write(&self, graph: &mut GraphRepository) -> CognitionResult<()> {
        let (handle, job) = (self.handle, self.job);
        if job.generation != handle.generation_id {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        assert_source_current(handle, job)?;
        graph.assert_cache_job_current(job)?;
        let windows = graph.cache_windows(job)?;
        let mut valid = graph.valid_cache_entry_ids(&handle.generation_id)?;
        if job.summary_status != "complete" || job.summary.trim().is_empty() {
            let receipt =
                CacheJobReceipt::no_summary(&job.generation, &job.episode_id, &job.revision);
            return graph.complete_cache_job(job, &receipt, &[]);
        }
        if windows.is_empty() {
            return graph.complete_cache_job(job, &CacheJobReceipt::no_window_summary(), &[]);
        }
        let mut receipts = Vec::new();
        let mut outcomes = Vec::new();
        for window in windows {
            let written = self.write_window(graph, &window, &mut valid)?;
            outcomes.push(EntryOutcome {
                entry_id: window.entry_id.clone(),
                admitted: written.receipt.admitted,
                reason: None,
                receipt: written.receipt.clone(),
            });
            for excluded in written.excluded {
                valid.remove(&excluded.id);
                outcomes.push(EntryOutcome {
                    entry_id: excluded.id,
                    admitted: false,
                    reason: Some(excluded.reason),
                    receipt: written.receipt.clone(),
                });
            }
            receipts.push(written.receipt);
        }
        assert_source_current(handle, job)?;
        graph.assert_cache_job_current(job)?;
        graph.complete_cache_job(job, &CacheJobReceipt::written(receipts), &outcomes)
    }

    /// Revalidates the window entry against the snapshot and writes it.
    /// Replaying a written block after a crash is harmless; the job receipt
    /// stays pending until the same gate has verified the actual file.
    fn write_window(
        &self,
        graph: &GraphRepository,
        window: &CacheWindow,
        valid: &mut HashSet<String>,
    ) -> CognitionResult<Written> {
        let handle = self.handle;
        let canonical = handle
            .canonical_snapshot_path
            .as_deref()
            .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
        let reader = ConversationSourceReader::open(canonical)
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
        let candidate = graph.valid_rebuild_cache_entries(
            &handle.generation_id,
            &[window.entry.view()],
            &handle.source_root,
            &reader,
            self.now,
        );
        let closed = reader
            .close()
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source));
        let candidate = candidate.and_then(|value| {
            closed?;
            Ok(value)
        })?;
        if candidate.contains(&window.entry_id) {
            valid.insert(window.entry_id.clone());
        } else {
            valid.remove(&window.entry_id);
        }
        let written = write_entry(self.data_root, self.cache, &window.entry, valid, self.job)?;
        if written.receipt.admitted {
            valid.insert(window.entry_id.clone());
        } else {
            valid.remove(&window.entry_id);
        }
        Ok(written)
    }
}

fn reconcile_missing(
    graph: &mut GraphRepository,
    handle: &MemoryGenerationHandle,
    cache: &Path,
) -> CognitionResult<()> {
    let rows = graph.complete_rebuild_cache_rows(&handle.generation_id)?;
    if rows.is_empty() {
        return Ok(());
    }
    let as_of = super::MemorySourceInventory::read(
        &handle.source_root.join("memory-source-inventory.json"),
    )?
    .as_of;
    let canonical = handle
        .canonical_snapshot_path
        .as_deref()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    let reader = ConversationSourceReader::open(canonical)
        .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
    let text = match fs::read_to_string(cache) {
        Ok(value) => value,
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(error(CognitionCode::HotCacheIoFailed)),
    };
    let valid = graph.valid_rebuild_cache_entries(
        &handle.generation_id,
        &physical_entries(&text),
        &handle.source_root,
        &reader,
        &as_of,
    )?;
    let outcomes = graph.rebuild_cache_outcomes(&handle.generation_id)?;
    let evidence =
        super::rebuild::readiness::cache::evaluate(&rows, &outcomes, &valid, &handle.generation_id);
    reader
        .close()
        .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
    graph.requeue_missing_rebuild_cache(&handle.generation_id, &evidence.actual_invalid_jobs)?;
    Ok(())
}

fn assert_source_current(
    handle: &MemoryGenerationHandle,
    job: &ClaimedCacheJob,
) -> CognitionResult<()> {
    if let Some((kind, id)) = job.source_key.split_once(':')
        && matches!(kind, "task_report" | "explicit_record")
    {
        let owner = read_typed_record(
            &handle.source_root,
            &handle.source_root.join("cognition/memory"),
            kind,
            id,
        )?
        .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
        if owner.revision != job.revision || owner.content_hash != job.source_hash {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
        return Ok(());
    }
    let canonical = handle
        .canonical_snapshot_path
        .as_ref()
        .ok_or_else(|| error(CognitionCode::MemorySnapshotChanged))?;
    let reader = ConversationSourceReader::open(canonical)
        .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?;
    let outcome = assert_conversation_current(&reader, job);
    let closed = reader
        .close()
        .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source));
    outcome.and(closed)
}

fn assert_conversation_current(
    reader: &ConversationSourceReader,
    job: &ClaimedCacheJob,
) -> CognitionResult<()> {
    let session = job
        .session_id
        .as_deref()
        .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
    let notice = if let Some(turn) = job.source_key.strip_prefix("conversation_turn:") {
        let turn_outcome = reader
            .read_turn_outcome(turn)
            .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?
            .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
        ConversationSourceNotice::Turn {
            session_id: session,
            turn_id: turn,
            outcome_generation: turn_outcome.generation,
            extraction_version: &job.extraction_version,
        }
    } else if let Some(message) = job.source_key.strip_prefix("conversation_message:") {
        ConversationSourceNotice::Standalone {
            session_id: session,
            message_id: message,
            source_hash: &job.source_hash,
            extraction_version: &job.extraction_version,
        }
    } else {
        return Err(error(CognitionCode::MemorySourceChanged));
    };
    assert_conversation_source_current(reader, notice, &job.revision, &now())
        .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))
}

struct Written {
    receipt: CacheWriteReceipt,
    excluded: Vec<format::ExcludedEntry>,
}

fn write_entry(
    data_root: &Path,
    path: &Path,
    entry: &SourceBackedHotCacheEntry,
    valid: &HashSet<String>,
    job: &ClaimedCacheJob,
) -> CognitionResult<Written> {
    let parent = path
        .parent()
        .ok_or_else(|| error(CognitionCode::HotCacheIoFailed))?;
    fs::create_dir_all(parent).map_err(io_failed)?;
    let existing = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(error(CognitionCode::HotCacheIoFailed)),
    };
    let rendered = format::render(
        &existing,
        Some(entry),
        valid,
        chrono::Utc::now().timestamp_millis(),
    )?;
    replace_file(data_root, path, parent, &rendered.body)?;
    if !rendered.audit.is_empty() {
        append_audit(data_root, path, &rendered.audit)?;
    }
    let receipt = CacheWriteReceipt {
        schema_version: "butler.hot-cache-write-receipt.v1",
        source_id: entry.entry_id.clone(),
        scope: if job.project_id.is_some() {
            ReceiptScope::Project
        } else {
            ReceiptScope::Global
        },
        project_id: job.project_id.clone(),
        path: path.display().to_string(),
        replayed: rendered.replayed,
        compacted: rendered.compacted,
        bytes: rendered.body.len(),
        generation_id: job.generation.clone(),
        episode_id: job.episode_id.clone(),
        source_revision: job.revision.clone(),
        excluded_entries: rendered
            .excluded
            .iter()
            .map(|item| ExcludedEntryReceipt {
                entry_id: item.id.clone(),
                reason: item.reason,
            })
            .collect(),
        admitted: rendered.admitted,
    };
    Ok(Written {
        receipt,
        excluded: rendered.excluded,
    })
}

/// Atomically replaces the cache file and syncs its directory.
fn replace_file(data_root: &Path, path: &Path, parent: &Path, body: &str) -> CognitionResult<()> {
    let temp = parent.join(format!(".cache-{}.tmp", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[path, parent, &temp])?;
    let written: CognitionResult<()> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(io_failed)?;
        file.write_all(body.as_bytes()).map_err(io_failed)?;
        file.sync_all().map_err(io_failed)?;
        fs::rename(&temp, path).map_err(io_failed)?;
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(io_failed)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Appends legacy and unparseable blocks removed from the cache to its audit file.
fn append_audit(data_root: &Path, path: &Path, audit: &str) -> CognitionResult<()> {
    let audit_path = path.with_extension("md.audit.md");
    ensure_data_authority(data_root, &[&audit_path])?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path)
        .map_err(io_failed)?;
    file.write_all(audit.as_bytes()).map_err(io_failed)?;
    file.sync_all().map_err(io_failed)
}

fn io_failed(source: std::io::Error) -> CognitionError {
    error(CognitionCode::HotCacheIoFailed).with_source(source)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
