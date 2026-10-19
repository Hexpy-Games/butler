//! Keeps the active generation's canonical inventory mirror current, one
//! bounded write step per poll. Recall stays exact without it (it overlays
//! the changes after the mirror's watermark), so a failed step only delays
//! the mirror. An unchanged store reads two values and writes nothing.

use std::sync::atomic::Ordering;

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

/// One step when the mirror may be behind; true while more steps remain.
/// Without a canonical change or queued notice since the last finished step
/// it reads nothing.
pub(super) async fn run(input: &Input) -> bool {
    if !input.inventory_due.swap(false, Ordering::AcqRel) {
        return false;
    }
    match step(input).await {
        Ok(more) => {
            if more {
                input.inventory_due.store(true, Ordering::Release);
            }
            more
        }
        Err(error) => {
            // Retried on the next poll, without spinning on this one.
            butler_core::diagnostic!("[native-memory-inventory] {}", error.code());
            input.inventory_due.store(true, Ordering::Release);
            false
        }
    }
}

async fn step(input: &Input) -> CognitionResult<bool> {
    let owned = input.clone();
    let handle = match blocking::run(move || resolve_input_generation(&owned)).await {
        Ok(handle) => handle,
        Err(error) if error.code() == CognitionCode::MemoryGenerationUnavailable.as_str() => {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let (owned, generation) = (input.clone(), handle.clone());
    if !blocking::run(move || needed(&owned, &generation)).await? {
        return Ok(false);
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
        return Ok(false);
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
        result.and_then(|more| released.map(|()| more))
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
