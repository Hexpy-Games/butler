//! Cache refresh after semantic projection, independent of embeddings.
use super::Input;
use crate::cognition::{CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget};
pub(super) async fn process(
    input: &Input,
    handle: Option<&MemoryGenerationHandle>,
) -> CognitionResult<bool> {
    if input.shutdown.is_cancelled() {
        return Ok(false);
    }
    let Some(handle) = handle else {
        return Ok(false);
    };
    if !input
        .probe
        .cache_work(&handle.graph_path, &(input.clock)())
        .await?
    {
        return Ok(false);
    }
    let target = input
        .target
        .clone()
        .unwrap_or(MemoryGenerationTarget::Active {
            expected_generation: handle.generation_id.clone(),
        });
    crate::cognition::generation::cache::advance_at(
        &input.data_root,
        &input.environment,
        input.coordinator.clone(),
        &target,
        &input.shutdown,
        (input.clock)(),
    )
    .await
}
