//! Bounded canonical outcome/recovered-source reconciliation after queue work.

use crate::cognition::CognitionCode;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use super::process::{Input, canonical_path, resolve_input_generation};
use crate::cognition::graph::{CatchupState, GraphRepository};
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
    pub sweeping: bool,
    pub outcome_cursor: Option<String>,
    pub recovered_message_cursor: Option<String>,
}

pub(super) async fn run_if_due(input: &Input) -> CognitionResult<bool> {
    let report = run(input, Schedule::IfDue).await?;
    Ok(report.ingested > 0 || (report.scanned > 0 && report.sweeping))
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
    if schedule == Schedule::Now
        || input
            .catchup_progress
            .lock()
            .as_ref()
            .is_some_and(|(_, state)| !state.sweep_done)
    {
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
    let persisted = input.probe.catchup_state(&handle.graph_path)?;
    let stored = input
        .catchup_progress
        .lock()
        .as_ref()
        .filter(|(path, _)| path == &handle.graph_path)
        .map_or_else(|| persisted.clone(), |(_, state)| state.clone());
    let canonical = match ConversationSourceReader::open(&canonical_path(&handle, &input.data_root))
    {
        Ok(reader) => reader,
        Err(error) if error.code() == "conversation_source_unavailable" => {
            return Ok(CatchupReport::default());
        }
        Err(error) => return Err(CognitionError::from(error)),
    };
    let revision = canonical.public_revision().map_err(CognitionError::from)?;
    let identity = canonical.source_identity().map_err(CognitionError::from)?;
    let cursors_valid = canonical
        .catchup_cursors_exist(stored.outcome.as_deref(), stored.message.as_deref())
        .map_err(CognitionError::from)?;
    let unclean = input
        .unclean_start
        .swap(false, std::sync::atomic::Ordering::AcqRel);
    if inventory_unchanged(
        &stored,
        revision,
        identity.as_deref(),
        unclean || !cursors_valid,
    ) {
        canonical.close().map_err(CognitionError::from)?;
        return Ok(unchanged_report(stored));
    }
    let mut pass = Pass::begin(
        stored.clone(),
        revision,
        identity,
        unclean || !cursors_valid,
    );
    pass.read_outcomes(&canonical)?;
    pass.read_recovered_sources(&canonical)?;
    canonical.close().map_err(CognitionError::from)?;
    let work = unregistered(input, &handle, std::mem::take(&mut pass.work))?;
    let scanned = pass.scanned;
    let missing = work.len();
    let registration = register(input, &handle, work).await?;
    if !registration.interrupted {
        pass.finish(epoch_ms(&(input.clock)()));
        if missing > 0 && pass.cursor_advanced(&persisted) {
            save_state(input, &handle, &pass.state).await?;
        }
        *input.catchup_progress.lock() = Some((handle.graph_path.clone(), pass.state.clone()));
    }
    Ok(CatchupReport {
        available: true,
        scanned,
        ingested: registration.ingested,
        wrapped: pass.wrapped,
        sweeping: !pass.state.sweep_done,
        outcome_cursor: pass.state.outcome,
        recovered_message_cursor: pass.state.message,
    })
}

/// Native messages beyond the recovered cursor must not be rescanned every
/// idle tick. Legacy stores without an identity retain reconciliation because
/// they cannot prove that the inventory is unchanged.
fn inventory_unchanged(
    stored: &CatchupState,
    revision: u64,
    identity: Option<&str>,
    invalidated: bool,
) -> bool {
    stored.sweep_done
        && !invalidated
        && identity.is_some()
        && stored.source_identity.as_deref() == identity
        && stored.sweep_revision == Some(revision)
}

fn unchanged_report(stored: CatchupState) -> CatchupReport {
    CatchupReport {
        available: true,
        outcome_cursor: stored.outcome,
        recovered_message_cursor: stored.message,
        ..CatchupReport::default()
    }
}

const OUTCOME_PAGE: usize = 255;
/// Notices one pass may read from both inventories.
const NOTICE_BUDGET: usize = 256;

/// Milliseconds since the epoch of an ISO-8601 clock reading; 0 when the
/// clock text does not parse.
fn epoch_ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso).map_or(0, |time| time.timestamp_millis())
}

/// Drops the notices whose observation a registered job already recorded.
/// Registering them again would only replay that job.
fn unregistered(
    input: &Input,
    handle: &crate::cognition::MemoryGenerationHandle,
    work: Vec<(CognitionConversationSourceNotice, String)>,
) -> CognitionResult<Vec<(CognitionConversationSourceNotice, String)>> {
    if work.is_empty() {
        return Ok(work);
    }
    let ids: Vec<String> = work.iter().map(|(_, id)| id.clone()).collect();
    let known = input
        .probe
        .registered_observations(&handle.graph_path, &ids)?;
    Ok(work
        .into_iter()
        .filter(|(_, id)| !known.contains(id))
        .collect())
}

/// One catch-up pass: the source notices to register, each with its
/// observation id, and the catch-up state after them.
struct Pass {
    state: CatchupState,
    /// A sweep from the start of both inventories began this pass.
    wrapped: bool,
    revision: u64,
    outcomes_at_end: bool,
    messages_at_end: bool,
    /// Notices read from the canonical store, registered or not.
    scanned: usize,
    work: Vec<(CognitionConversationSourceNotice, String)>,
}

impl Pass {
    /// A new source or a crash can invalidate previously advanced cursors.
    /// An append-only revision increase never does.
    fn begin(state: CatchupState, revision: u64, identity: Option<String>, unclean: bool) -> Self {
        let replaced = state.sweep_revision.is_some_and(|old| revision < old)
            || (state.source_identity.is_some() && state.source_identity != identity);
        let mut pass = Self {
            state,
            wrapped: false,
            revision,
            outcomes_at_end: false,
            messages_at_end: false,
            scanned: 0,
            work: Vec::with_capacity(256),
        };
        if unclean || replaced {
            pass.start_sweep();
        }
        pass.state.sweep_revision = Some(revision);
        pass.state.source_identity = identity;
        pass
    }

    fn cursor_advanced(&self, stored: &CatchupState) -> bool {
        self.scanned > 0
            && (self.state.outcome != stored.outcome || self.state.message != stored.message)
    }

    /// Restarts both cursors from the start of their inventories.
    fn start_sweep(&mut self) {
        self.state.outcome = None;
        self.state.message = None;
        self.state.sweep_done = false;
        self.state.sweep_revision = Some(self.revision);
        self.wrapped = true;
    }

    /// Marks the sweep done once both cursors have reached their ends.
    fn finish(&mut self, now_ms: i64) {
        if self.outcomes_at_end && self.messages_at_end && !self.state.sweep_done {
            self.state.sweep_done = true;
            self.state.swept_at_ms = Some(now_ms);
        }
    }

    /// Reads up to 255 recall outcomes after the outcome cursor.
    fn read_outcomes(&mut self, canonical: &ConversationSourceReader) -> CognitionResult<()> {
        let outcomes = canonical
            .read_recall_outcome_page(self.state.outcome.as_deref(), Some(OUTCOME_PAGE))
            .map_err(CognitionError::from)?;
        self.outcomes_at_end = outcomes.len() < OUTCOME_PAGE;
        for outcome in outcomes {
            self.state.outcome = Some(outcome.id.clone());
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
    /// messages after the message cursor.
    fn read_recovered_sources(
        &mut self,
        canonical: &ConversationSourceReader,
    ) -> CognitionResult<()> {
        let remaining = NOTICE_BUDGET - self.work.len();
        let mut scanned = 0;
        while scanned < remaining {
            // Limit simultaneous hydrated bodies; the source's total scan budget
            // remains 256 and only compact notices survive to the awaits below.
            let batch_size = (remaining - scanned).min(16);
            let messages = canonical
                .read_recovered_source_page(self.state.message.as_deref(), Some(batch_size))
                .map_err(CognitionError::from)?;
            let count = messages.len();
            for message in messages {
                let hash = recovered_source_hash(&message.parts)?;
                self.state.message = Some(message.message.id.clone());
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
                self.messages_at_end = true;
                break;
            }
        }
        self.scanned = self.work.len();
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

async fn save_state(
    input: &Input,
    handle: &crate::cognition::MemoryGenerationHandle,
    state: &CatchupState,
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
        let saved = graph.save_catchup_state(state);
        graph.close()?;
        saved
    })();
    let released = lease.release(result.is_ok()).map_err(CognitionError::from);
    result.and(released)
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
