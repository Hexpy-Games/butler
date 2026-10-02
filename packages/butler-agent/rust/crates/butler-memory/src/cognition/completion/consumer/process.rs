//! Queue authority, registration, then one pending semantic quantum.

use crate::cognition::CognitionCode;
use parking_lot::Mutex;
use std::sync::atomic::AtomicBool;
use std::{path::PathBuf, sync::Arc, time::Instant};

use serde::{Deserialize, Serialize};
use serde_json::Number;
use tokio_util::sync::CancellationToken;

use super::{MemorySyncPoll, catchup, paused};
mod cache;
mod typed;
pub(super) mod vector;
use crate::cognition::generation::{resolve_active_generation, resolve_generation};
use crate::cognition::registration::{ProjectSemanticWindowInput, ProjectionSourceNotice};
use crate::cognition::sources::read_typed_record;
use crate::cognition::{
    CognitionConversationSourceNotice, CognitionEmbeddingPort, CognitionError,
    CognitionPathEnvironment, CognitionRegistrationService, CognitionResult,
    ConversationRegistrationOutcome, MemoryGenerationTarget, RegisterConversationSourceInput,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteCoordinator};
use crate::lenient::{Arg, Obj};
use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};

#[derive(Clone)]
pub(super) struct Input {
    pub data_root: PathBuf,
    pub environment: CognitionPathEnvironment,
    pub registration: Arc<CognitionRegistrationService>,
    pub embedding: Option<Arc<dyn CognitionEmbeddingPort>>,
    pub target: Option<MemoryGenerationTarget>,
    pub coordinator: Arc<CognitionWriteCoordinator>,
    pub clock: Arc<dyn Fn() -> String + Send + Sync>,
    pub catchup_at: Arc<Mutex<Option<Instant>>>,
    pub unclean_start: Arc<AtomicBool>,
    pub catchup_progress: Arc<Mutex<Option<(PathBuf, crate::cognition::graph::CatchupState)>>>,
    pub probe: Arc<super::probe::ProbeReader>,
    pub vector_batch: Arc<AtomicBool>,
    pub daily_batch: bool,
    pub shutdown: CancellationToken,
}

/// The head of `queue/sync.jsonl`, read leniently: every field keeps what
/// was sent so mismatches and dead letters behave as on the raw request.
#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct SyncRequest {
    #[serde(default)]
    schema_version: Arg<String>,
    #[serde(default)]
    job_id: Arg<String>,
    #[serde(default)]
    source: Arg<Obj<SyncSource>>,
}

/// The source a sync request asks to register.
#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct SyncSource {
    #[serde(default)]
    pub kind: Arg<String>,
    #[serde(default)]
    pub record_kind: Arg<String>,
    #[serde(default)]
    pub record_id: Arg<String>,
    #[serde(default)]
    pub revision: Arg<String>,
    #[serde(default)]
    pub operation_id: Arg<String>,
    #[serde(default)]
    pub session_id: Arg<String>,
    #[serde(default)]
    pub turn_id: Arg<String>,
    #[serde(default)]
    pub outcome_generation: Arg<Number>,
}

impl SyncRequest {
    /// The request's source; a source that is not an object reads as empty.
    pub(super) fn source(&self) -> &SyncSource {
        static EMPTY: SyncSource = SyncSource {
            kind: Arg::Missing,
            record_kind: Arg::Missing,
            record_id: Arg::Missing,
            revision: Arg::Missing,
            operation_id: Arg::Missing,
            session_id: Arg::Missing,
            turn_id: Arg::Missing,
            outcome_generation: Arg::Missing,
        };
        self.source.valid().map_or(&EMPTY, |Obj(source)| source)
    }
}

/// A `queue/dead-letter.jsonl` line.
#[derive(Serialize)]
struct DeadLetter<'a> {
    timestamp: &'a str,
    session_id: &'a Arg<String>,
    project: &'static str,
    reason: &'a str,
    exit_code: Option<u8>,
    stderr_tail: &'a str,
}

pub(super) async fn poll(input: Input) -> CognitionResult<MemorySyncPoll> {
    if input.shutdown.is_cancelled() {
        return Ok(MemorySyncPoll::Deferred);
    }
    if input.daily_batch {
        return super::vector_schedule::daily(&input).await;
    }
    let owned = input.clone();
    if super::blocking::run(move || paused(&owned)).await? {
        return Ok(MemorySyncPoll::Deferred);
    }
    if input.target.is_some() {
        let (projected, generation) = project_next(&input).await?;
        let cached = cache::process(&input, generation.as_ref()).await?;
        let vectorized =
            super::vector_schedule::process(&input, generation.as_ref(), projected || cached)
                .await?;
        return Ok(if projected || cached || vectorized {
            MemorySyncPoll::Processed
        } else {
            MemorySyncPoll::Idle
        });
    }
    let root = input.environment.memory_root(&input.data_root);
    let mut processed = false;
    let mut queued = false;
    let mut queue_error = None;
    let queue_root = root.clone();
    match super::blocking::run(move || super::super::queue::peek(&queue_root)).await {
        Ok(Some(entry)) => {
            queued = true;
            let request: SyncRequest = crate::lenient::view(&entry);
            match process_entry(&input, &root, &request).await {
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
                butler_core::diagnostic!("[native-memory-sync-catchup] {}", catchup_error.code());
                return Err(queue_error);
            }
            None => return Err(catchup_error),
        },
    };
    if let Some(error) = queue_error {
        return Err(error);
    }
    let (projected, generation) = project_next(&input).await?;
    let cached = cache::process(&input, generation.as_ref()).await?;
    let vectorized =
        super::vector_schedule::process(&input, generation.as_ref(), projected || cached).await?;
    Ok(
        if processed || caught_up || projected || cached || vectorized {
            MemorySyncPoll::Processed
        } else if queued {
            MemorySyncPoll::Deferred
        } else {
            MemorySyncPoll::Idle
        },
    )
}

/// Registers the conversation turn a v3 request names once its completion
/// observation matches; typed-record requests go to `typed`. A request
/// whose observation is missing or different is dead-lettered and acked.
async fn process_entry(
    input: &Input,
    root: &std::path::Path,
    request: &SyncRequest,
) -> CognitionResult<bool> {
    if request.schema_version.valid().map(String::as_str) != Some("butler.memory-sync-request.v3") {
        return Err(error(CognitionCode::MemorySyncLegacyEntryUnsupported));
    }
    let job_id = request
        .job_id
        .valid()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error(CognitionCode::MemorySyncEntryInvalid))?;
    let source = request.source();
    let kind = source.kind.valid().map(String::as_str);
    if matches!(kind, Some("task_report" | "explicit_record")) {
        return typed::process(input, root, request, job_id).await;
    }
    if kind != Some("conversation_turn") {
        return Err(error(CognitionCode::MemorySyncSourceUnavailable));
    }
    let observation_root = root.to_owned();
    let observation_id = job_id.to_owned();
    let observation = super::blocking::run(move || {
        Ok(super::super::observation::read_verified(
            &observation_root,
            &observation_id,
        ))
    })
    .await?;
    let Some(observation) = observation else {
        return reject_invalid(root, request, job_id, &(input.clock)()).await;
    };
    if !source
        .session_id
        .same_json(&observation.conversation_session_id)
        || !source.turn_id.same_json(&observation.conversation_turn_id)
        || !source
            .outcome_generation
            .same_json(&observation.outcome_generation)
    {
        return reject_invalid(root, request, job_id, &(input.clock)()).await;
    }
    let invalid = || error(CognitionCode::MemorySyncEntryInvalid);
    let session = source.session_id.valid().ok_or_else(invalid)?;
    let turn = source.turn_id.valid().ok_or_else(invalid)?;
    let generation = source
        .outcome_generation
        .valid()
        .and_then(Number::as_f64)
        .ok_or_else(invalid)?;
    register_turn(input, root, request, job_id, (session, turn, generation)).await
}

/// Registers the turn on the active generation and acks the request once
/// its source is complete (or ineligible / superseded).
async fn register_turn(
    input: &Input,
    root: &std::path::Path,
    request: &SyncRequest,
    job_id: &str,
    (session, turn, generation): (&str, &str, f64),
) -> CognitionResult<bool> {
    let owned = input.clone();
    let handle = super::blocking::run(move || {
        resolve_active_generation(&owned.data_root, &owned.environment)
    })
    .await?;
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
        Err(error) if error.code() == "memory_source_ineligible" => {
            return super::blocking::ack(root, job_id).await;
        }
        Err(error) => {
            if input.shutdown.is_cancelled() {
                return Ok(false);
            }
            let _ = dead_letter(root, request, error.code(), &(input.clock)()).await;
            return Ok(false);
        }
    };
    let progress = match registered {
        ConversationRegistrationOutcome::Registered(progress)
        | ConversationRegistrationOutcome::Replayed(progress) => progress,
        ConversationRegistrationOutcome::InternalControlSuperseded => {
            return super::blocking::ack(root, job_id).await;
        }
    };
    if !progress.source.is_complete() {
        return Ok(false);
    }
    super::blocking::ack(root, job_id).await
}

async fn reject_invalid(
    root: &std::path::Path,
    request: &SyncRequest,
    job_id: &str,
    now: &str,
) -> CognitionResult<bool> {
    let _ = dead_letter(root, request, "completion_observation_invalid", now).await;
    super::blocking::ack(root, job_id).await
}

/// Appends the request to `queue/dead-letter.jsonl` with `reason`.
async fn dead_letter(
    root: &std::path::Path,
    request: &SyncRequest,
    reason: &str,
    now: &str,
) -> CognitionResult<()> {
    let root = root.to_owned();
    let request = request.clone();
    let reason = reason.to_owned();
    let now = now.to_owned();
    super::blocking::run(move || dead_letter_sync(&root, &request, &reason, &now)).await
}

fn dead_letter_sync(
    root: &std::path::Path,
    request: &SyncRequest,
    reason: &str,
    now: &str,
) -> CognitionResult<()> {
    use std::{
        fs::{self, OpenOptions},
        io::Write,
    };
    let dlq = |e: std::io::Error| {
        CognitionError::new(CognitionCode::MemorySyncDlqError, e.to_string()).with_source(e)
    };
    let path = root.join("queue/dead-letter.jsonl");
    fs::create_dir_all(root.join("queue")).map_err(dlq)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(dlq)?;
    let record = DeadLetter {
        timestamp: now,
        session_id: &request.source().session_id,
        project: "canonical",
        reason,
        exit_code: None,
        stderr_tail: if reason == "completion_observation_invalid" {
            "canonical completion observation is missing, corrupt, or does not match its queue request"
        } else {
            reason
        },
    };
    let line = serde_json::to_string(&record).map_err(|e| {
        CognitionError::new(CognitionCode::MemorySyncDlqError, e.to_string()).with_source(e)
    })?;
    file.write_all(line.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .map_err(dlq)
}

pub(super) async fn project_next(
    input: &Input,
) -> CognitionResult<(bool, Option<crate::cognition::MemoryGenerationHandle>)> {
    if input.shutdown.is_cancelled() {
        return Ok((false, None));
    }
    let owned = input.clone();
    let handle = match super::blocking::run(move || resolve_input_generation(&owned)).await {
        Ok(handle) => handle,
        Err(error) if error.code() == "memory_generation_unavailable" => return Ok((false, None)),
        Err(error) => return Err(error),
    };
    // Recovery takes the write lease, so it runs only when a window is held
    // by an owner that may have died.
    if input.probe.recoverable_windows(&handle.graph_path).await? {
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
    }
    let pending = input
        .probe
        .pending_job(&handle.graph_path, &(input.clock)())
        .await?;
    let Some(pending) = pending else {
        return Ok((false, Some(handle)));
    };
    let job_id = pending.job_id.clone();
    let owned = input.clone();
    let generation = handle.clone();
    let notice = super::blocking::run(move || pending_notice(&owned, &generation, pending)).await?;
    let projected = input
        .registration
        .project_semantic_window(ProjectSemanticWindowInput {
            data_root: input.data_root.clone(),
            target: input
                .target
                .clone()
                .unwrap_or(MemoryGenerationTarget::Active {
                    expected_generation: handle.generation_id.clone(),
                }),
            job_id,
            notice,
            cancellation: Some(input.shutdown.child_token()),
            deadline_at_epoch_ms: None,
            wait_class: CognitionWaitClass::Background,
        })
        .await?;
    Ok((projected.is_some(), Some(handle)))
}

/// The source notice of a pending semantic job, checked against the
/// current canonical conversation or typed record.
fn pending_notice(
    input: &Input,
    handle: &crate::cognition::MemoryGenerationHandle,
    pending: crate::cognition::graph::PendingSemanticJob,
) -> CognitionResult<ProjectionSourceNotice> {
    let notice = if let Some(turn_id) = pending.source_key.strip_prefix("conversation_turn:") {
        let canonical = ConversationSourceReader::open(&canonical_path(handle, &input.data_root))
            .map_err(CognitionError::from)?;
        let outcome = canonical
            .read_turn_outcome(turn_id)
            .map_err(CognitionError::from)?
            .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
        canonical.close().map_err(CognitionError::from)?;
        ProjectionSourceNotice::Conversation(CognitionConversationSourceNotice::Turn {
            session_id: pending
                .session_id
                .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?,
            turn_id: turn_id.into(),
            outcome_generation: outcome.generation,
            extraction_version: pending.extraction_version,
        })
    } else if let Some(message_id) = pending.source_key.strip_prefix("conversation_message:") {
        ProjectionSourceNotice::Conversation(CognitionConversationSourceNotice::Standalone {
            session_id: pending
                .session_id
                .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?,
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
        .ok_or_else(|| error(CognitionCode::MemorySourceChanged))?;
        if owner.content_hash != pending.source_hash {
            return Err(error(CognitionCode::MemorySourceChanged));
        }
        ProjectionSourceNotice::Typed {
            source_kind: kind.into(),
            record_id: record_id.into(),
            revision: owner.revision,
            content_hash: owner.content_hash,
            operation_id: owner.operation_id,
        }
    } else {
        return Err(error(CognitionCode::MemoryProjectionSourceInvalid));
    };
    Ok(notice)
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

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}

#[cfg(test)]
mod tests;
