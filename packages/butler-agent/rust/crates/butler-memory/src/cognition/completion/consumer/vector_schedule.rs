//! Event-driven admission before any vector probe or write lease.
use std::sync::atomic::Ordering;

use super::{MemorySyncPoll, process::Input};
use crate::cognition::{CognitionResult, MemoryGenerationHandle};

/// At ~36 units/light day, even a tenfold heavy day fits without loading the model.
pub const VECTOR_BACKLOG_CAP: usize = 1_024;
/// The daily window normally drains sooner; two days bounds missed windows on new work.
pub const VECTOR_MAX_AGE_HOURS: i64 = 48;

pub(super) async fn admit(
    input: &Input,
    generation: Option<&MemoryGenerationHandle>,
    text_advanced: bool,
) -> CognitionResult<bool> {
    let Some(generation) = generation else {
        return Ok(false);
    };
    if input.daily_batch
        || input.target.is_some()
        || input.vector_batch.load(Ordering::Acquire)
        || input
            .embedding
            .as_ref()
            .is_some_and(|embedding| embedding.is_warm())
    {
        return Ok(true);
    }
    // Deferred vectors add no idle database reads, leases, writes or fast polls.
    if !text_advanced {
        return Ok(false);
    }
    let cutoff = chrono::DateTime::parse_from_rfc3339(&(input.clock)())
        .ok()
        .and_then(|now| now.checked_sub_signed(chrono::Duration::hours(VECTOR_MAX_AGE_HOURS)))
        .map(|now| now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let due = input
        .probe
        .vector_batch_due(&generation.graph_path, &cutoff)
        .await?;
    input.vector_batch.store(due, Ordering::Release);
    Ok(due)
}

pub(super) async fn process(
    input: &Input,
    generation: Option<&MemoryGenerationHandle>,
    text_advanced: bool,
) -> CognitionResult<bool> {
    if let Some(embedding) = &input.embedding
        && admit(input, generation, text_advanced).await?
    {
        super::process::vector::process(input, embedding.as_ref()).await
    } else {
        Ok(false)
    }
}

/// Daily work waits on the actual cancellable write lease, rather than polling
/// a busy gate. Queue/semantic errors cannot prevent a vector-only drain.
pub(super) async fn daily(input: &Input) -> CognitionResult<MemorySyncPoll> {
    if input.embedding.is_none() {
        return Ok(MemorySyncPoll::Idle);
    }
    let owned = input.clone();
    let generation =
        super::blocking::run(move || super::process::resolve_input_generation(&owned)).await?;
    Ok(if process(input, Some(&generation), false).await? {
        MemorySyncPoll::Processed
    } else {
        MemorySyncPoll::Idle
    })
}
