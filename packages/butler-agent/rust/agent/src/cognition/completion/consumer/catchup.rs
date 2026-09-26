//! Bounded canonical outcome/recovered-source reconciliation after queue work.

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::process::{Input, canonical_path, resolve_input_generation};
use crate::{
    cognition::{
        CognitionConversationSourceNotice, CognitionError, CognitionResult,
        ConversationRegistrationOutcome, MemoryGenerationTarget, RegisterConversationSourceInput,
        assert_mutation_authority,
        graph::{CatchupCursors, GraphRepository},
    },
    conversation::ConversationSourceReader,
    coordination::{CognitionWaitClass, CognitionWriteAcquire},
};

#[derive(Clone, Debug, Default)]
pub(super) struct CatchupReport {
    pub available: bool,
    pub scanned: usize,
    pub ingested: usize,
    pub wrapped: bool,
    pub outcome_cursor: Option<String>,
    pub recovered_message_cursor: Option<String>,
}

pub(super) async fn run_if_due(input: &Input) -> CognitionResult<bool> {
    Ok(run(input, false).await?.ingested > 0)
}

pub(super) async fn run_once(input: &Input) -> CognitionResult<CatchupReport> {
    run(input, true).await
}

async fn run(input: &Input, force: bool) -> CognitionResult<CatchupReport> {
    if input.shutdown.is_cancelled() {
        return Ok(CatchupReport::default());
    }
    if !force {
        let mut last = input.catchup_at.lock();
        if last.is_some_and(|time| time.elapsed() < Duration::from_secs(60)) {
            return Ok(CatchupReport::default());
        }
        *last = Some(Instant::now());
    }
    let handle = match resolve_input_generation(input) {
        Ok(handle) => handle,
        Err(error) if error.code == "memory_generation_unavailable" => {
            return Ok(CatchupReport::default());
        }
        Err(error) => return Err(error),
    };
    let graph = GraphRepository::open(&handle.graph_path)?;
    let mut cursors = graph.catchup_cursors()?;
    graph.close()?;
    let canonical = match ConversationSourceReader::open(&canonical_path(&handle, &input.data_root))
    {
        Ok(reader) => reader,
        Err(error) if error.code() == "conversation_source_unavailable" => {
            return Ok(CatchupReport::default());
        }
        Err(error) => return Err(CognitionError::new(error.code(), error.message())),
    };
    let mut outcomes = canonical
        .read_recall_outcome_page(cursors.outcome.as_deref(), Some(255))
        .map_err(CognitionError::from)?;
    let mut wrapped = false;
    if outcomes.is_empty() && cursors.outcome.is_some() {
        cursors.outcome = None;
        wrapped = true;
        outcomes = canonical
            .read_recall_outcome_page(None, Some(255))
            .map_err(CognitionError::from)?;
    }
    let remaining = 256 - outcomes.len();
    let mut work = Vec::with_capacity(256);
    for outcome in outcomes {
        cursors.outcome = Some(outcome.id.clone());
        work.push((
            CognitionConversationSourceNotice::Turn {
                session_id: outcome.session_id,
                turn_id: outcome.turn_id,
                outcome_generation: outcome.generation,
                extraction_version: "memory-extract-v3".into(),
            },
            format!("catchup:outcome:{}", outcome.id),
        ));
    }
    let mut scanned = 0;
    while scanned < remaining {
        // Limit simultaneous hydrated bodies; the source's total scan budget
        // remains 256 and only compact notices survive to the awaits below.
        let batch_size = (remaining - scanned).min(16);
        let messages = canonical
            .read_recovered_source_page(cursors.message.as_deref(), Some(batch_size))
            .map_err(CognitionError::from)?;
        if messages.is_empty() {
            if scanned == 0 && cursors.message.is_some() && !wrapped {
                cursors.message = None;
                wrapped = true;
                continue;
            }
            break;
        }
        let count = messages.len();
        for message in messages {
            let hash = recovered_source_hash(&message.parts)?;
            cursors.message = Some(message.message.id.clone());
            work.push((
                CognitionConversationSourceNotice::Standalone {
                    session_id: message.message.session_id,
                    message_id: message.message.id.clone(),
                    source_hash: hash.clone(),
                    extraction_version: "memory-extract-v3".into(),
                },
                format!("catchup:message:{}:{hash}", message.message.id),
            ));
        }
        scanned += count;
        if count < batch_size {
            break;
        }
    }
    canonical.close().map_err(CognitionError::from)?;
    let scanned_total = work.len();
    let mut ingested = 0;
    for (notice, observation_id) in work {
        if input.shutdown.is_cancelled() {
            return Ok(CatchupReport {
                available: true,
                scanned: scanned_total,
                ingested,
                wrapped,
                outcome_cursor: cursors.outcome,
                recovered_message_cursor: cursors.message,
            });
        }
        let outcome = input
            .registration
            .register_conversation_source(RegisterConversationSourceInput {
                data_root: input.data_root.clone(),
                target: input
                    .target
                    .clone()
                    .unwrap_or(MemoryGenerationTarget::Active {
                        expected_generation: handle.generation_id.clone(),
                    }),
                notice,
                completion_job_id: Some(observation_id),
                cancellation: Some(input.shutdown.child_token()),
                deadline_at_epoch_ms: None,
                wait_class: CognitionWaitClass::Background,
            })
            .await;
        match outcome {
            Ok(
                ConversationRegistrationOutcome::Registered(_)
                | ConversationRegistrationOutcome::Replayed(_)
                | ConversationRegistrationOutcome::InternalControlSuperseded,
            ) => ingested += 1,
            Err(error)
                if matches!(
                    error.code,
                    "memory_source_ineligible" | "memory_source_not_terminal"
                ) => {}
            Err(error) => return Err(error),
        }
    }
    save_cursors(input, &handle, &cursors).await?;
    Ok(CatchupReport {
        available: true,
        scanned: scanned_total,
        ingested,
        wrapped,
        outcome_cursor: cursors.outcome,
        recovered_message_cursor: cursors.message,
    })
}

fn recovered_source_hash(
    parts: &[crate::conversation::ConversationPart],
) -> CognitionResult<String> {
    let mut encoded = String::from("[");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            encoded.push(',');
        }
        encoded.push('[');
        encoded.push_str(&serde_json::to_string(&part.id).map_err(json_error)?);
        encoded.push(',');
        crate::json::append_json(&part.content_json, &mut encoded).map_err(json_error)?;
        encoded.push(']');
    }
    encoded.push(']');
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}

fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_catchup_json_error", error.to_string())
}

async fn save_cursors(
    input: &Input,
    handle: &crate::cognition::MemoryGenerationHandle,
    cursors: &CatchupCursors,
) -> CognitionResult<()> {
    let lock = input.environment.consolidation_lock(&input.data_root);
    let lease = input
        .coordinator
        .acquire(
            CognitionWriteAcquire::immediate(lock.clone(), "projection"),
            CognitionWaitClass::Background,
        )
        .await
        .map_err(CognitionError::from)?
        .ok_or_else(|| error("memory_write_busy"))?;
    lease.assert_for_path(&lock).map_err(CognitionError::from)?;
    let target = input
        .target
        .clone()
        .unwrap_or(MemoryGenerationTarget::Active {
            expected_generation: handle.generation_id.clone(),
        });
    let result = (|| {
        assert_mutation_authority(&input.data_root, &input.environment, &target, handle)?;
        let mut graph = GraphRepository::open(&handle.graph_path)?;
        let saved = graph.save_catchup_cursors(cursors);
        graph.close()?;
        saved
    })();
    let released = lease.release(result.is_ok()).map_err(CognitionError::from);
    result.and(released)
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
