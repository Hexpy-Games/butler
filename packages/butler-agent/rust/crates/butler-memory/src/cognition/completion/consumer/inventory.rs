//! Keeps the active generation's canonical inventory mirror current, one
//! bounded write step per poll. Recall stays exact without it (it overlays
//! the changes after the mirror's watermark), so a failed step only delays
//! the mirror. An unchanged store reads two values and writes nothing.

use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;

use super::blocking;
use super::process::{Input, canonical_path, resolve_input_generation};
use crate::cognition::graph::GraphRepository;
use crate::cognition::sources::{inventory_sync_needed, inventory_sync_step};
use crate::cognition::{
    CognitionCode, CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget,
    assert_mutation_authority,
};
use crate::coordination::{CognitionWaitClass, CognitionWriteAcquire};
use butler_turn::conversation::ConversationSourceReader;

/// When the inventory mirror may be behind: at start, after a canonical
/// change, after a queue head changed or was processed, and while a step
/// left work or could not run.
#[derive(Default)]
pub(super) struct InventoryWake {
    due: AtomicBool,
    queue_head: Mutex<Option<String>>,
}

impl InventoryWake {
    /// Due at start.
    pub(super) fn started() -> Self {
        Self {
            due: AtomicBool::new(true),
            queue_head: Mutex::new(None),
        }
    }

    pub(super) fn mark(&self) {
        self.due.store(true, Ordering::Release);
    }

    /// A completion notice follows its canonical commit; a deferred head
    /// that stays the same brings nothing new.
    pub(super) fn queue_head(&self, head: Option<&str>, processed: bool) {
        let mut last = self.queue_head.lock();
        if processed || last.as_deref() != head {
            self.mark();
        }
        *last = head.map(str::to_owned);
    }
}

/// What one poll's inventory step did.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    /// Nothing to do, or the mirror caught up.
    Done,
    /// Wrote a step and more remain.
    More,
    /// Could not run now (no generation, write lease busy, failed); retried
    /// on a later poll.
    Busy,
}

/// One step when the mirror may be behind. Without a reason to look since
/// the last finished step it reads nothing.
pub(super) async fn run(input: &Input) -> Step {
    if !input.inventory.due.swap(false, Ordering::AcqRel) {
        return Step::Done;
    }
    let step = step(input).await.unwrap_or_else(|error| {
        butler_core::diagnostic!("[native-memory-inventory] {}", error.code());
        Step::Busy
    });
    if step != Step::Done {
        input.inventory.mark();
    }
    step
}

async fn step(input: &Input) -> CognitionResult<Step> {
    let owned = input.clone();
    let handle = match blocking::run(move || resolve_input_generation(&owned)).await {
        Ok(handle) => handle,
        Err(error) if error.code() == CognitionCode::MemoryGenerationUnavailable.as_str() => {
            return Ok(Step::Busy);
        }
        Err(error) => return Err(error),
    };
    let (owned, generation) = (input.clone(), handle.clone());
    if !blocking::run(move || needed(&owned, &generation)).await? {
        return Ok(Step::Done);
    }
    let lock = input.environment.consolidation_lock(&input.data_root);
    let Some(lease) = input
        .coordinator
        .acquire(
            CognitionWriteAcquire::immediate(lock.clone(), "projection"),
            CognitionWaitClass::Background,
        )
        .await
        .map_err(crate::cognition::CognitionError::from)?
    else {
        return Ok(Step::Busy);
    };
    let owned = input.clone();
    blocking::run(move || {
        let result = (|| {
            lease
                .assert_for_path(&lock)
                .map_err(crate::cognition::CognitionError::from)?;
            let target = owned
                .target
                .clone()
                .unwrap_or(MemoryGenerationTarget::Active {
                    expected_generation: handle.generation_id.clone(),
                });
            assert_mutation_authority(&owned.data_root, &owned.environment, &target, &handle)?;
            let Some(reader) = open_reader(&owned, &handle)? else {
                return Ok(false);
            };
            let mut graph = GraphRepository::open(&handle.graph_path)?;
            let more = inventory_sync_step(&mut graph, &reader);
            graph.close()?;
            reader
                .close()
                .map_err(crate::cognition::CognitionError::from)?;
            more
        })();
        let released = lease
            .release(result.is_ok())
            .map_err(crate::cognition::CognitionError::from);
        result.and_then(|more| released.map(|()| if more { Step::More } else { Step::Done }))
    })
    .await
}

fn needed(input: &Input, handle: &MemoryGenerationHandle) -> CognitionResult<bool> {
    let Some(reader) = open_reader(input, handle)? else {
        return Ok(false);
    };
    let graph = GraphRepository::open_readonly(&handle.graph_path)?;
    let needed = inventory_sync_needed(&graph, &reader);
    graph.close()?;
    reader
        .close()
        .map_err(crate::cognition::CognitionError::from)?;
    needed
}

/// The generation's canonical store; `None` while it does not exist.
fn open_reader(
    input: &Input,
    handle: &MemoryGenerationHandle,
) -> CognitionResult<Option<ConversationSourceReader>> {
    match ConversationSourceReader::open(&canonical_path(handle, &input.data_root)) {
        Ok(reader) => Ok(Some(reader)),
        Err(error) if error.code() == "conversation_source_unavailable" => Ok(None),
        Err(error) => Err(error.into()),
    }
}
