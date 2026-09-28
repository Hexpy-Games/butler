//! Bounded canonical outcome/recovered-source reconciliation after queue work.

use crate::cognition::CognitionCode;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::process::{Input, canonical_path, resolve_input_generation};
use crate::cognition::graph::{CatchupCursors, GraphRepository};
use crate::cognition::{
    CognitionConversationSourceNotice, CognitionError, CognitionResult,
    ConversationRegistrationOutcome, MemoryGenerationTarget, RegisterConversationSourceInput,
    assert_mutation_authority,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire};
use butler_turn::conversation::ConversationSourceReader;

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
    Ok(run(input, Schedule::IfDue).await?.ingested > 0)
}

pub(super) async fn run_once(input: &Input) -> CognitionResult<CatchupReport> {
    run(input, Schedule::Now).await
}

/// Whether a pass may be skipped because one ran within the last minute.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Schedule {
    IfDue,
    Now,
}

/// Claims the catch-up slot; `false` when a pass ran within the last
/// minute and this one is only due-based.
fn claim_slot(input: &Input, schedule: Schedule) -> bool {
    if schedule == Schedule::Now {
        return true;
    }
    let mut last = input.catchup_at.lock();
    if last.is_some_and(|time| time.elapsed() < Duration::from_secs(60)) {
        return false;
    }
    *last = Some(Instant::now());
    true
}

async fn run(input: &Input, schedule: Schedule) -> CognitionResult<CatchupReport> {
    if input.shutdown.is_cancelled() || !claim_slot(input, schedule) {
        return Ok(CatchupReport::default());
    }
    let handle = match resolve_input_generation(input) {
        Ok(handle) => handle,
        Err(error) if error.code() == "memory_generation_unavailable" => {
            return Ok(CatchupReport::default());
        }
        Err(error) => return Err(error),
    };
    let graph = GraphRepository::open(&handle.graph_path)?;
    let cursors = graph.catchup_cursors()?;
    graph.close()?;
    let canonical = match ConversationSourceReader::open(&canonical_path(&handle, &input.data_root))
    {
        Ok(reader) => reader,
        Err(error) if error.code() == "conversation_source_unavailable" => {
            return Ok(CatchupReport::default());
        }
        Err(error) => return Err(CognitionError::from(error)),
    };
    let mut pass = Pass {
        cursors,
        wrapped: false,
        work: Vec::with_capacity(256),
    };
    pass.read_outcomes(&canonical)?;
    pass.read_recovered_sources(&canonical)?;
    canonical.close().map_err(CognitionError::from)?;
    let scanned = pass.work.len();
    let work = std::mem::take(&mut pass.work);
    let registration = register(input, &handle, work).await?;
    if !registration.interrupted {
        save_cursors(input, &handle, &pass.cursors).await?;
    }
    Ok(CatchupReport {
        available: true,
        scanned,
        ingested: registration.ingested,
        wrapped: pass.wrapped,
        outcome_cursor: pass.cursors.outcome,
        recovered_message_cursor: pass.cursors.message,
    })
}

/// One catch-up pass: the source notices to register, each with its
/// observation id, and the cursors after them.
struct Pass {
    cursors: CatchupCursors,
    /// A cursor wrapped around to the start this pass.
    wrapped: bool,
    work: Vec<(CognitionConversationSourceNotice, String)>,
}

impl Pass {
    /// Reads up to 255 recall outcomes after the outcome cursor, wrapping
    /// once when the cursor is at the end.
    fn read_outcomes(&mut self, canonical: &ConversationSourceReader) -> CognitionResult<()> {
        let mut outcomes = canonical
            .read_recall_outcome_page(self.cursors.outcome.as_deref(), Some(255))
            .map_err(CognitionError::from)?;
        if outcomes.is_empty() && self.cursors.outcome.is_some() {
            self.cursors.outcome = None;
            self.wrapped = true;
            outcomes = canonical
                .read_recall_outcome_page(None, Some(255))
                .map_err(CognitionError::from)?;
        }
        for outcome in outcomes {
            self.cursors.outcome = Some(outcome.id.clone());
            self.work.push((
                CognitionConversationSourceNotice::Turn {
                    session_id: outcome.session_id,
                    turn_id: outcome.turn_id,
                    outcome_generation: outcome.generation,
                    extraction_version: "memory-extract-v3".into(),
                },
                format!("catchup:outcome:{}", outcome.id),
            ));
        }
        Ok(())
    }

    /// Fills the rest of the 256-notice budget with recovered standalone
    /// messages, wrapping the message cursor once when it is at the end.
    fn read_recovered_sources(
        &mut self,
        canonical: &ConversationSourceReader,
    ) -> CognitionResult<()> {
        let remaining = 256 - self.work.len();
        let mut scanned = 0;
        while scanned < remaining {
            // Limit simultaneous hydrated bodies; the source's total scan budget
            // remains 256 and only compact notices survive to the awaits below.
            let batch_size = (remaining - scanned).min(16);
            let messages = canonical
                .read_recovered_source_page(self.cursors.message.as_deref(), Some(batch_size))
                .map_err(CognitionError::from)?;
            if messages.is_empty() {
                if scanned == 0 && self.cursors.message.is_some() && !self.wrapped {
                    self.cursors.message = None;
                    self.wrapped = true;
                    continue;
                }
                break;
            }
            let count = messages.len();
            for message in messages {
                let hash = recovered_source_hash(&message.parts)?;
                self.cursors.message = Some(message.message.id.clone());
                self.work.push((
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
        Ok(())
    }
}

/// How registering a pass's notices went.
struct Registration {
    ingested: usize,
    /// Shutdown stopped the pass before every notice was registered.
    interrupted: bool,
}

/// Registers each notice with the conversation registration; ineligible and
/// not-yet-terminal sources are skipped.
async fn register(
    input: &Input,
    handle: &crate::cognition::MemoryGenerationHandle,
    work: Vec<(CognitionConversationSourceNotice, String)>,
) -> CognitionResult<Registration> {
    let mut ingested = 0;
    for (notice, observation_id) in work {
        if input.shutdown.is_cancelled() {
            return Ok(Registration {
                ingested,
                interrupted: true,
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
                    error.code(),
                    "memory_source_ineligible" | "memory_source_not_terminal"
                ) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(Registration {
        ingested,
        interrupted: false,
    })
}

fn recovered_source_hash(
    parts: &[butler_turn::conversation::ConversationPart],
) -> CognitionResult<String> {
    let mut encoded = String::from("[");
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            encoded.push(',');
        }
        encoded.push('[');
        encoded.push_str(&serde_json::to_string(&part.id).map_err(json_error)?);
        encoded.push(',');
        butler_core::json::append_json(&part.content_json, &mut encoded).map_err(json_error)?;
        encoded.push(']');
    }
    encoded.push(']');
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}

fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryCatchupJsonError, error.to_string()).with_source(error)
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
        .ok_or_else(|| error(CognitionCode::MemoryWriteBusy))?;
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

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
