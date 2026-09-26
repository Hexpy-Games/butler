//! Queue authority, registration, then one pending semantic quantum.

use parking_lot::Mutex;
use std::{path::PathBuf, sync::Arc, time::Instant};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{MemorySyncPoll, catchup, paused};
mod typed;
mod vector;
use crate::{
    cognition::{
        CognitionConversationSourceNotice, CognitionEmbeddingPort, CognitionError,
        CognitionPathEnvironment, CognitionRegistrationService, CognitionResult,
        ConversationRegistrationOutcome, MemoryGenerationTarget, RegisterConversationSourceInput,
        generation::{resolve_active_generation, resolve_generation},
        graph::GraphRepository,
        registration::ProjectSemanticWindowInput,
        registration::ProjectionSourceNotice,
        sources::read_typed_record,
    },
    conversation::{ConversationSourceReader, conversation_store_path},
    coordination::{CognitionWaitClass, CognitionWriteCoordinator},
};

pub(super) struct Input {
    pub data_root: PathBuf,
    pub environment: CognitionPathEnvironment,
    pub registration: Arc<CognitionRegistrationService>,
    pub embedding: Option<Arc<dyn CognitionEmbeddingPort>>,
    pub target: Option<MemoryGenerationTarget>,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub clock: Arc<dyn Fn() -> String + Send + Sync>,
    pub catchup_at: Arc<Mutex<Option<Instant>>>,
    pub shutdown: CancellationToken,
}

pub(super) async fn poll(input: Input) -> CognitionResult<MemorySyncPoll> {
    if input.shutdown.is_cancelled() {
        return Ok(MemorySyncPoll::Deferred);
    }
    if paused(&input)? {
        return Ok(MemorySyncPoll::Deferred);
    }
    if input.target.is_some() {
        let projected = project_next(&input).await?;
        let vectorized = if let Some(embedding) = &input.embedding {
            vector::process(&input, embedding.as_ref()).await?
        } else {
            false
        };
        return Ok(if projected || vectorized {
            MemorySyncPoll::Processed
        } else {
            MemorySyncPoll::Idle
        });
    }
    let root = input.environment.memory_root(&input.data_root);
    let mut processed = false;
    let mut queued = false;
    let mut queue_error = None;
    match super::super::queue::peek(&root) {
        Ok(Some(entry)) => {
            queued = true;
            match process_entry(&input, &root, &entry).await {
                Ok(did_process) => processed = did_process,
                Err(error) => queue_error = Some(error),
            }
        }
        Ok(None) => {}
        Err(error) => queue_error = Some(error),
    }
    let caught_up = match catchup::run_if_due(&input).await {
        Ok(caught_up) => caught_up,
        Err(catchup_error) => match queue_error {
            Some(queue_error) => {
                eprintln!("[native-memory-sync-catchup] {}", catchup_error.code);
                return Err(queue_error);
            }
            None => return Err(catchup_error),
        },
    };
    if let Some(error) = queue_error {
        return Err(error);
    }
    let projected = project_next(&input).await?;
    let vectorized = if let Some(embedding) = &input.embedding {
        vector::process(&input, embedding.as_ref()).await?
    } else {
        false
    };
    Ok(if processed || caught_up || projected || vectorized {
        MemorySyncPoll::Processed
    } else if queued {
        MemorySyncPoll::Deferred
    } else {
        MemorySyncPoll::Idle
    })
}

async fn process_entry(
    input: &Input,
    root: &std::path::Path,
    entry: &Value,
) -> CognitionResult<bool> {
    if entry["schema_version"] != "butler.memory-sync-request.v3" {
        return Err(error("memory_sync_legacy_entry_unsupported"));
    }
    let job_id = entry["job_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error("memory_sync_entry_invalid"))?;
    let source = &entry["source"];
    if matches!(
        source["kind"].as_str(),
        Some("task_report" | "explicit_record")
    ) {
        return typed::process(input, root, entry, job_id).await;
    }
    if source["kind"] != "conversation_turn" {
        return Err(error("memory_sync_source_unavailable"));
    }
    let Some(observation) = super::super::observation::read_verified(root, job_id)? else {
        return reject_invalid(root, entry, job_id, &(input.clock)());
    };
    if source["session_id"] != observation["conversation_session_id"]
        || source["turn_id"] != observation["conversation_turn_id"]
        || source["outcome_generation"] != observation["outcome_generation"]
    {
        return reject_invalid(root, entry, job_id, &(input.clock)());
    }
    let session = source["session_id"]
        .as_str()
        .ok_or_else(|| error("memory_sync_entry_invalid"))?;
    let turn = source["turn_id"]
        .as_str()
        .ok_or_else(|| error("memory_sync_entry_invalid"))?;
    let generation = source["outcome_generation"]
        .as_f64()
        .ok_or_else(|| error("memory_sync_entry_invalid"))?;
    let handle = resolve_active_generation(&input.data_root, &input.environment)?;
    let registered = input
        .registration
        .register_conversation_source(RegisterConversationSourceInput {
            data_root: input.data_root.clone(),
            target: MemoryGenerationTarget::Active {
                expected_generation: handle.generation_id,
            },
            notice: CognitionConversationSourceNotice::Turn {
                session_id: session.into(),
                turn_id: turn.into(),
                outcome_generation: generation,
                extraction_version: "memory-extract-v3".into(),
            },
            completion_job_id: Some(job_id.into()),
            cancellation: Some(input.shutdown.child_token()),
            deadline_at_epoch_ms: None,
            wait_class: CognitionWaitClass::Background,
        })
        .await;
    let registered = match registered {
        Ok(outcome) => outcome,
        Err(error) if error.code == "memory_source_ineligible" => {
            return super::super::queue::ack(root, job_id);
        }
        Err(error) => {
            if input.shutdown.is_cancelled() {
                return Ok(false);
            }
            let _ = dead_letter(root, entry, error.code, &(input.clock)());
            return Ok(false);
        }
    };
    let progress = match registered {
        ConversationRegistrationOutcome::Registered(progress)
        | ConversationRegistrationOutcome::Replayed(progress) => progress,
        ConversationRegistrationOutcome::InternalControlSuperseded => {
            return super::super::queue::ack(root, job_id);
        }
    };
    if progress.source["state"] != "complete" {
        return Ok(false);
    }
    super::super::queue::ack(root, job_id)
}

fn reject_invalid(
    root: &std::path::Path,
    entry: &Value,
    job_id: &str,
    now: &str,
) -> CognitionResult<bool> {
    let _ = dead_letter(root, entry, "completion_observation_invalid", now);
    super::super::queue::ack(root, job_id)
}

fn dead_letter(
    root: &std::path::Path,
    entry: &Value,
    reason: &str,
    now: &str,
) -> CognitionResult<()> {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
    };
    let path = root.join("queue/dead-letter.jsonl");
    fs::create_dir_all(root.join("queue"))
        .map_err(|e| CognitionError::new("memory_sync_dlq_error", e.to_string()))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| CognitionError::new("memory_sync_dlq_error", e.to_string()))?;
    let record = serde_json::json!({
        "timestamp":now,
        "session_id":entry["source"]["session_id"],
        "project":"canonical",
        "reason":reason,
        "exit_code":null,
        "stderr_tail":if reason == "completion_observation_invalid" {
            "canonical completion observation is missing, corrupt, or does not match its queue request"
        } else { reason },
    });
    file.write_all(record.to_string().as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|e| CognitionError::new("memory_sync_dlq_error", e.to_string()))
}

pub(super) async fn project_next(input: &Input) -> CognitionResult<bool> {
    if input.shutdown.is_cancelled() {
        return Ok(false);
    }
    let handle = match resolve_input_generation(input) {
        Ok(handle) => handle,
        Err(error) if error.code == "memory_generation_unavailable" => return Ok(false),
        Err(error) => return Err(error),
    };
    input
        .registration
        .recover_semantic_windows(
            input.data_root.clone(),
            handle.clone(),
            input
                .target
                .clone()
                .unwrap_or(MemoryGenerationTarget::Active {
                    expected_generation: handle.generation_id.clone(),
                }),
            input.shutdown.child_token(),
        )
        .await?;
    let graph = GraphRepository::open(&handle.graph_path)?;
    let pending = graph.pending_semantic_job(&(input.clock)())?;
    graph.close()?;
    let Some(pending) = pending else {
        return Ok(false);
    };
    let notice = if let Some(turn_id) = pending.source_key.strip_prefix("conversation_turn:") {
        let canonical = ConversationSourceReader::open(&canonical_path(&handle, &input.data_root))
            .map_err(|e| CognitionError::new(e.code(), e.message()))?;
        let outcome = canonical
            .read_turn_outcome(turn_id)
            .map_err(|e| CognitionError::new(e.code(), e.message()))?
            .ok_or_else(|| error("memory_source_changed"))?;
        canonical
            .close()
            .map_err(|e| CognitionError::new(e.code(), e.message()))?;
        ProjectionSourceNotice::Conversation(CognitionConversationSourceNotice::Turn {
            session_id: pending
                .session_id
                .ok_or_else(|| error("memory_source_changed"))?,
            turn_id: turn_id.into(),
            outcome_generation: outcome.generation,
            extraction_version: pending.extraction_version,
        })
    } else if let Some(message_id) = pending.source_key.strip_prefix("conversation_message:") {
        ProjectionSourceNotice::Conversation(CognitionConversationSourceNotice::Standalone {
            session_id: pending
                .session_id
                .ok_or_else(|| error("memory_source_changed"))?,
            message_id: message_id.into(),
            source_hash: pending.source_hash,
            extraction_version: pending.extraction_version,
        })
    } else if let Some((kind, record_id)) = pending.source_key.split_once(':')
        && matches!(kind, "task_report" | "explicit_record")
    {
        let owner = read_typed_record(
            &handle.source_root,
            &handle.source_root.join("cognition/memory"),
            kind,
            record_id,
        )?
        .ok_or_else(|| error("memory_source_changed"))?;
        if owner.content_hash != pending.source_hash {
            return Err(error("memory_source_changed"));
        }
        ProjectionSourceNotice::Typed {
            source_kind: kind.into(),
            record_id: record_id.into(),
            revision: owner.revision,
            content_hash: owner.content_hash,
            operation_id: owner.operation_id,
        }
    } else {
        return Err(error("memory_projection_source_invalid"));
    };
    let projected = input
        .registration
        .project_semantic_window(ProjectSemanticWindowInput {
            data_root: input.data_root.clone(),
            target: input
                .target
                .clone()
                .unwrap_or(MemoryGenerationTarget::Active {
                    expected_generation: handle.generation_id,
                }),
            job_id: pending.job_id,
            notice,
            cancellation: Some(input.shutdown.child_token()),
            deadline_at_epoch_ms: None,
            wait_class: CognitionWaitClass::Background,
        })
        .await?;
    Ok(projected.is_some())
}

pub(super) fn resolve_input_generation(
    input: &Input,
) -> CognitionResult<crate::cognition::MemoryGenerationHandle> {
    match &input.target {
        Some(target) => resolve_generation(&input.data_root, &input.environment, target),
        None => resolve_active_generation(&input.data_root, &input.environment),
    }
}

pub(super) fn canonical_path(
    handle: &crate::cognition::MemoryGenerationHandle,
    data_root: &std::path::Path,
) -> PathBuf {
    handle
        .canonical_snapshot_path
        .clone()
        .unwrap_or_else(|| conversation_store_path(data_root))
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}

#[cfg(test)]
mod tests;
