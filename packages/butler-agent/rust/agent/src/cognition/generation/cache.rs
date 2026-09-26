//! Source-backed hot cache for a separate building generation.

mod format;
mod health;
pub(in crate::cognition) use format::physical_entries;
pub(in crate::cognition) use health::read as read_hot_cache_health;

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
    sync::Arc,
};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult, ConversationSourceNotice,
        MemoryGenerationHandle, MemoryGenerationTarget, assert_conversation_source_current,
        assert_mutation_authority, ensure_data_authority,
        graph::{ClaimedCacheJob, GraphRepository},
        resolve_generation,
        sources::read_typed_record,
    },
    conversation::ConversationSourceReader,
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
};

pub(crate) async fn advance(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
    target: &MemoryGenerationTarget,
    cancellation: &CancellationToken,
) -> CognitionResult<bool> {
    if cancellation.is_cancelled() {
        return Err(error("memory_operation_aborted"));
    }
    let MemoryGenerationTarget::Rebuild { .. } = target else {
        return Err(error("memory_generation_changed"));
    };
    let handle = resolve_generation(data_root, environment, target)?;
    let lock = environment.consolidation_lock(data_root);
    let cache = handle.root.join("hot/cache.md");
    let cache_lock = handle.root.join("hot/cache.md.lock");
    ensure_data_authority(
        data_root,
        &[
            &lock,
            &handle.root,
            &handle.graph_path,
            &handle.source_root,
            &cache,
            &cache_lock,
        ],
    )?;
    let acquisition = coordinator.acquire(
        CognitionWriteAcquire {
            lock_path: lock.clone(),
            purpose: Some("rebuild_hot_cache".into()),
            deadline_at_epoch_ms: None,
            cancellation: Some(cancellation.clone()),
        },
        CognitionWaitClass::Background,
    );
    let lease = acquisition
        .await
        .map_err(|_| error("memory_write_busy"))?
        .ok_or_else(|| error("memory_write_busy"))?;
    let data_root = data_root.to_owned();
    let environment = environment.clone();
    let target = target.clone();
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        let result = (|| {
            lease
                .assert_for_path(&lock)
                .map_err(|_| error("memory_write_busy"))?;
            if cancellation.is_cancelled() {
                return Err(error("memory_operation_aborted"));
            }
            let current = resolve_generation(&data_root, &environment, &target)?;
            assert_mutation_authority(&data_root, &environment, &target, &current)?;
            run_claimed(&data_root, &current, &cache, &cancellation)
        })();
        let released = lease
            .release(result.is_ok())
            .map_err(|_| error("memory_write_busy"));
        result.and_then(|value| {
            released?;
            Ok(value)
        })
    })
    .await
    .map_err(|_| error("memory_cache_operation_failed"))?
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
    let produced = (|| {
        if cancellation.is_cancelled() {
            return Err(error("memory_operation_aborted"));
        }
        if job.generation != handle.generation_id {
            return Err(error("memory_generation_changed"));
        }
        assert_source_current(handle, &job)?;
        graph.assert_cache_job_current(&job)?;
        let windows = graph.cache_windows(&job)?;
        let mut valid = graph.valid_cache_entry_ids(&handle.generation_id)?;
        let mut receipts = Vec::new();
        let mut outcomes = Vec::new();
        if job.summary_status != "complete" || job.summary.trim().is_empty() {
            let receipt = json!({"schema":"butler.memory-hot-cache-receipt.v1","outcome":"excluded","reason":"no_summary","generation":job.generation,"episode_id":job.episode_id,"source_revision":job.revision});
            graph.complete_cache_job(&job, &receipt, &[])?;
            return Ok(());
        }
        if windows.is_empty() {
            let receipt = json!({"outcome":"excluded","reason":"no_window_summary","entries":[]});
            graph.complete_cache_job(&job, &receipt, &[])?;
            return Ok(());
        }
        for window in windows {
            // Replaying a written block after a crash is harmless; the job receipt
            // remains pending until the same gate has verified the actual file.
            let canonical = handle
                .canonical_snapshot_path
                .as_deref()
                .ok_or_else(|| error("memory_snapshot_changed"))?;
            let reader = ConversationSourceReader::open(canonical)
                .map_err(|_| error("memory_snapshot_changed"))?;
            let candidate = graph.valid_rebuild_cache_entries(
                &handle.generation_id,
                std::slice::from_ref(&window.entry),
                &handle.source_root,
                &reader,
                &now,
            );
            let closed = reader.close().map_err(|_| error("memory_snapshot_changed"));
            let candidate = candidate.and_then(|value| {
                closed?;
                Ok(value)
            })?;
            if candidate.contains(&window.entry_id) {
                valid.insert(window.entry_id.clone());
            } else {
                valid.remove(&window.entry_id);
            }
            let written = write_entry(
                data_root,
                cache,
                &window.entry_id,
                &window.entry,
                &valid,
                &job,
            )?;
            let receipt = written.receipt;
            if written.admitted {
                valid.insert(window.entry_id.clone());
            } else {
                valid.remove(&window.entry_id);
            }
            outcomes.push((
                window.entry_id.clone(),
                written.admitted,
                None,
                receipt.clone(),
            ));
            for excluded in written.excluded {
                valid.remove(&excluded.id);
                let reason = Some(excluded.reason.to_owned());
                outcomes.push((excluded.id, false, reason, receipt.clone()));
            }
            receipts.push(receipt);
        }
        assert_source_current(handle, &job)?;
        graph.assert_cache_job_current(&job)?;
        let applied = receipts.iter().any(|entry| entry["admitted"] == true);
        let receipt = json!({"outcome":if applied{"applied"}else{"excluded"},"entries":receipts});
        graph.complete_cache_job(&job, &receipt, &outcomes)?;
        Ok(())
    })();
    if let Err(failure) = &produced {
        let _ = graph.fail_cache_job(
            &job,
            if failure.code.starts_with("hot_cache_") {
                failure.code
            } else {
                "hot_cache_io_failed"
            },
        );
    }
    let closed = graph.close();
    produced.and_then(|()| {
        closed?;
        Ok(true)
    })
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
    let stored: Value = serde_json::from_slice(
        &fs::read(handle.source_root.join("memory-source-inventory.json"))
            .map_err(|_| error("memory_snapshot_changed"))?,
    )
    .map_err(|_| error("memory_snapshot_changed"))?;
    let as_of = stored["as_of"]
        .as_str()
        .ok_or_else(|| error("memory_inventory_changed"))?;
    let canonical = handle
        .canonical_snapshot_path
        .as_deref()
        .ok_or_else(|| error("memory_snapshot_changed"))?;
    let reader =
        ConversationSourceReader::open(canonical).map_err(|_| error("memory_snapshot_changed"))?;
    let text = match fs::read_to_string(cache) {
        Ok(value) => value,
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(error("hot_cache_io_failed")),
    };
    let physical = physical_entries(&text);
    let valid = graph.valid_rebuild_cache_entries(
        &handle.generation_id,
        &physical,
        &handle.source_root,
        &reader,
        as_of,
    )?;
    let outcomes = graph.rebuild_cache_outcomes(&handle.generation_id)?;
    let evidence =
        super::rebuild::readiness::cache::evaluate(&rows, &outcomes, &valid, &handle.generation_id);
    reader
        .close()
        .map_err(|_| error("memory_snapshot_changed"))?;
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
        .ok_or_else(|| error("memory_source_changed"))?;
        if owner.revision != job.revision || owner.content_hash != job.source_hash {
            return Err(error("memory_source_changed"));
        }
        return Ok(());
    }
    let canonical = handle
        .canonical_snapshot_path
        .as_ref()
        .ok_or_else(|| error("memory_snapshot_changed"))?;
    let reader =
        ConversationSourceReader::open(canonical).map_err(|_| error("memory_source_changed"))?;
    let session = job
        .session_id
        .as_deref()
        .ok_or_else(|| error("memory_source_changed"))?;
    let outcome = (|| {
        let notice = if let Some(turn) = job.source_key.strip_prefix("conversation_turn:") {
            let turn_outcome = reader
                .read_turn_outcome(turn)
                .map_err(|_| error("memory_source_changed"))?
                .ok_or_else(|| error("memory_source_changed"))?;
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
            return Err(error("memory_source_changed"));
        };
        assert_conversation_source_current(&reader, notice, &job.revision, &now())
            .map_err(|_| error("memory_source_changed"))
    })();
    let closed = reader.close().map_err(|_| error("memory_source_changed"));
    outcome.and(closed)
}

struct Written {
    receipt: Value,
    admitted: bool,
    excluded: Vec<format::ExcludedEntry>,
}
fn write_entry(
    data_root: &Path,
    path: &Path,
    id: &str,
    entry: &Value,
    valid: &HashSet<String>,
    job: &ClaimedCacheJob,
) -> CognitionResult<Written> {
    let parent = path.parent().ok_or_else(|| error("hot_cache_io_failed"))?;
    fs::create_dir_all(parent).map_err(|_| error("hot_cache_io_failed"))?;
    let existing = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err(error("hot_cache_io_failed")),
    };
    let rendered = format::render(
        &existing,
        Some(entry),
        valid,
        chrono::Utc::now().timestamp_millis(),
    )
    .map_err(error)?;
    let temp = parent.join(format!(".cache-{}.tmp", uuid::Uuid::new_v4()));
    ensure_data_authority(data_root, &[path, parent, &temp])?;
    let written: CognitionResult<()> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| error("hot_cache_io_failed"))?;
        file.write_all(rendered.body.as_bytes())
            .map_err(|_| error("hot_cache_io_failed"))?;
        file.sync_all().map_err(|_| error("hot_cache_io_failed"))?;
        fs::rename(&temp, path).map_err(|_| error("hot_cache_io_failed"))?;
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| error("hot_cache_io_failed"))?;
        Ok(())
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written?;
    if !rendered.audit.is_empty() {
        let audit = path.with_extension("md.audit.md");
        ensure_data_authority(data_root, &[&audit])?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(audit)
            .map_err(|_| error("hot_cache_io_failed"))?;
        file.write_all(rendered.audit.as_bytes())
            .map_err(|_| error("hot_cache_io_failed"))?;
        file.sync_all().map_err(|_| error("hot_cache_io_failed"))?;
    }
    let excluded = rendered.excluded;
    let excluded_entries = excluded
        .iter()
        .map(|item| json!({"entry_id":item.id,"reason":item.reason}))
        .collect::<Vec<_>>();
    let scope = if job.project_id.is_some() {
        "project"
    } else {
        "global"
    };
    let receipt = json!({"schema_version":"butler.hot-cache-write-receipt.v1","source_id":id,"scope":scope,"project_id":job.project_id,
        "path":path.display().to_string(),"replayed":rendered.replayed,"compacted":rendered.compacted,"bytes":rendered.body.len(),
        "generation_id":job.generation,"episode_id":job.episode_id,"source_revision":job.revision,"excluded_entries":excluded_entries,"admitted":rendered.admitted});
    Ok(Written {
        receipt,
        admitted: rendered.admitted,
        excluded,
    })
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
