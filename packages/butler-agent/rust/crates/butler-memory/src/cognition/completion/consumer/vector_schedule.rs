//! Event-driven admission before any vector probe or write lease.
use super::{MemorySyncPoll, process::Input};
use crate::cognition::{CognitionResult, MemoryGenerationHandle};

pub(super) async fn process(
    input: &Input,
    generation: Option<&MemoryGenerationHandle>,
) -> CognitionResult<bool> {
    // Without the memory model, pending units are the later backfill queue; no probes.
    if let Some(embedding) = input
        .embedding
        .as_ref()
        .filter(|owner| owner.enabled() && owner.is_warm())
        && generation.is_some()
    {
        super::process::vector::process(input, embedding.as_ref()).await
    } else {
        Ok(false)
    }
}

/// Daily work waits on the actual cancellable write lease, rather than polling
/// a busy gate. Queue/semantic errors cannot prevent a vector-only drain.
pub(super) async fn daily(input: &Input) -> CognitionResult<MemorySyncPoll> {
    if !input
        .embedding
        .as_ref()
        .is_some_and(|owner| owner.enabled())
    {
        return Ok(MemorySyncPoll::Idle);
    }
    let owned = input.clone();
    let generation =
        super::blocking::run(move || super::process::resolve_input_generation(&owned)).await?;
    Ok(if process(input, Some(&generation)).await? {
        MemorySyncPoll::Processed
    } else {
        MemorySyncPoll::Idle
    })
}
