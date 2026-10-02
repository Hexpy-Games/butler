//! Source-backed hot cache for active and building generations.
//!
//! [`advance`] claims one pending job, renders its windows in memory, and
//! publishes changed bytes once before recording a durable receipt. Rebuilds
//! also reconcile missing retained entries at their quiescent boundary.

mod format;
#[cfg(test)]
mod format_pin;
mod health;
mod publication;
pub(in crate::cognition) mod receipt;
pub(in crate::cognition) use format::{
    Authority, HotCacheEntryView, Salience, Scope, SourceBackedHotCacheEntry, SourceClass,
    SourceKind, physical_entries,
};
pub(in crate::cognition) use health::{HotCacheHealth, read as read_hot_cache_health};

use crate::cognition::CognitionCode;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio_util::sync::CancellationToken;

use crate::cognition::graph::{ClaimedCacheJob, GraphRepository};
use crate::cognition::sources::read_typed_record;
use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, ConversationSourceNotice,
    MemoryGenerationHandle, MemoryGenerationTarget, assert_conversation_source_current,
    assert_mutation_authority, ensure_data_authority, resolve_generation,
};
use crate::coordination::CognitionWriteCoordinator;
use butler_turn::conversation::ConversationSourceReader;

/// Advances one cache job of an active or building generation. Returns `false` when no
/// job was pending.
pub async fn advance(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<bool> {
    advance_at(
        data_root,
        environment,
        coordinator,
        target,
        cancellation,
        now(),
    )
    .await
}

/// The live consumer supplies its application clock, also used by projection.
pub(in crate::cognition) async fn advance_at(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
    now: String,
) -> CognitionResult<bool> {
    if cancellation.is_cancelled() {
        return Err(error(CognitionCode::MemoryOperationAborted));
    }
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
    let purpose = match target {
        MemoryGenerationTarget::Active { .. } => "active_hot_cache",
        MemoryGenerationTarget::Rebuild { .. } => "rebuild_hot_cache",
    };
    let lease = super::stage::acquire(&coordinator, &lock, purpose, cancellation).await?;
    let step = CacheStep {
        data_root: data_root.to_owned(),
        environment: environment.clone(),
        target: target.clone(),
        lock,
        cache,
        cancellation: cancellation.clone(),
        now,
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
    now: String,
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
        run_claimed(&self, &current)
    }
}

fn run_claimed(step: &CacheStep, handle: &MemoryGenerationHandle) -> CognitionResult<bool> {
    let mut graph = GraphRepository::open(&handle.graph_path)?;
    graph.ensure_cache_index(&step.cancellation)?;
    let now = &step.now;
    let mut job = graph.claim_cache_job(now)?;
    if job.is_none() && matches!(step.target, MemoryGenerationTarget::Rebuild { .. }) {
        // A full retained-cache scan is needed at the quiescent boundary, not
        // before each pending job in a large rebuild.
        reconcile_missing(&mut graph, handle, &step.cache)?;
        job = graph.claim_cache_job(now)?;
    }
    let Some(job) = job else {
        graph.close()?;
        return Ok(false);
    };
    let writer = JobWriter {
        step,
        handle,
        job: &job,
        now,
    };
    let produced = if step.cancellation.is_cancelled() {
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
        if step.cancellation.is_cancelled() {
            let _ = graph.repend_cache_job(&job);
        } else {
            let _ = graph.fail_cache_job(&job, code);
        }
    }
    let closed = graph.close();
    produced.and_then(|()| {
        closed?;
        Ok(true)
    })
}

/// Writes one claimed job's windows and completes it.
struct JobWriter<'a> {
    step: &'a CacheStep,
    handle: &'a MemoryGenerationHandle,
    job: &'a ClaimedCacheJob,
    now: &'a str,
}

impl JobWriter<'_> {
    fn write(&self, graph: &mut GraphRepository) -> CognitionResult<()> {
        let (handle, job) = (self.handle, self.job);
        if job.generation != handle.generation_id {
            return Err(error(CognitionCode::MemoryGenerationChanged));
        }
        if job.source_current {
            assert_source_current(handle, job, &self.step.data_root, self.now)?;
        }
        graph.assert_cache_job_current(job)?;
        let windows = if job.source_current
            && job.summary_status == "complete"
            && !job.summary.trim().is_empty()
        {
            graph.cache_windows(job)?
        } else {
            Vec::new()
        };
        let existing = publication::read(&self.step.cache)?;
        let mut views = physical_entries(&existing);
        views.extend(windows.iter().map(|window| window.entry.view()));
        let canonical = canonical_path(handle, &self.step.data_root);
        let reader = ConversationSourceReader::open(&canonical)
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
        let valid = graph.valid_rebuild_cache_entries(
            &handle.generation_id,
            &views,
            &handle.source_root,
            &reader,
            self.now,
        )?;
        reader
            .close()
            .map_err(|source| error(CognitionCode::MemorySnapshotChanged).with_source(source))?;
        let rendered =
            publication::render_job(&existing, &windows, &valid, job, &self.step.cache, self.now)?;
        if job.source_current {
            assert_source_current(handle, job, &self.step.data_root, self.now)?;
        }
        graph.assert_cache_job_current(job)?;
        self.authority()?;
        // This is the publication boundary. Once begun, finish durably on this
        // leased blocking task; the consumer close path waits for it.
        if self.step.cancellation.is_cancelled() {
            return Err(error(CognitionCode::MemoryOperationAborted));
        }
        publication::publish(&self.step.data_root, &self.step.cache, &existing, &rendered)?;
        self.authority()?;
        graph.complete_cache_job(job, &rendered.receipt, &rendered.outcomes)
    }

    fn authority(&self) -> CognitionResult<()> {
        assert_mutation_authority(
            &self.step.data_root,
            &self.step.environment,
            &self.step.target,
            self.handle,
        )
    }
}

fn canonical_path(handle: &MemoryGenerationHandle, data_root: &Path) -> PathBuf {
    handle
        .canonical_snapshot_path
        .clone()
        .unwrap_or_else(|| butler_turn::conversation::conversation_store_path(data_root))
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
    data_root: &Path,
    as_of: &str,
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
    let canonical = canonical_path(handle, data_root);
    let reader = ConversationSourceReader::open(&canonical)
        .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))?;
    let outcome = assert_conversation_current(&reader, job, as_of);
    let closed = reader
        .close()
        .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source));
    outcome.and(closed)
}

fn assert_conversation_current(
    reader: &ConversationSourceReader,
    job: &ClaimedCacheJob,
    as_of: &str,
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
    assert_conversation_source_current(reader, notice, &job.revision, as_of)
        .map_err(|source| error(CognitionCode::MemorySourceChanged).with_source(source))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
