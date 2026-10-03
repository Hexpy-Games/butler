//! Event-driven instruction capture drain before semantic/vector work.
use super::{MemorySyncPoll, process::Input};
use crate::cognition::CognitionResult;
pub(super) async fn drain(input: &Input) -> CognitionResult<Option<MemorySyncPoll>> {
    if input.target.is_some() {
        return Ok(None);
    }
    match input.instruction_owner.drain_captures().await {
        Ok(count) if count > 0 => Ok(Some(MemorySyncPoll::Processed)),
        Err(error) if error.message() == "rule_write_busy" => Ok(Some(MemorySyncPoll::Deferred)),
        Err(error) => Err(error),
        _ => Ok(None),
    }
}
