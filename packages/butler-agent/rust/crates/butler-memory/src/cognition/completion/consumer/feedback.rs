//! Event-driven feedback receipt drain before semantic or vector work.
use super::{MemorySyncPoll, process::Input};
use crate::cognition::{CognitionResult, FeedbackBufferService};

pub(super) async fn drain(input: &Input) -> CognitionResult<Option<MemorySyncPoll>> {
    if input.target.is_some() {
        return Ok(None);
    }
    let feedback = FeedbackBufferService::new(
        input.data_root.clone(),
        input.environment.clone(),
        input.coordinator.clone(),
    );
    match feedback.drain_signalled().await {
        Ok(count) if count > 0 => Ok(Some(MemorySyncPoll::Processed)),
        Err(error) if error.code() == "memory_write_busy" => Ok(Some(MemorySyncPoll::Deferred)),
        Err(error) => Err(error),
        _ => Ok(None),
    }
}
