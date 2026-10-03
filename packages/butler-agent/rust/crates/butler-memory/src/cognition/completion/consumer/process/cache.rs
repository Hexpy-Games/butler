//! Cache refresh after semantic projection, independent of embeddings.
use super::Input;
use crate::cognition::generation::cache::CacheAdvance;
use crate::cognition::{CognitionResult, MemoryGenerationHandle, MemoryGenerationTarget};
pub(super) async fn process(
    input: &Input,
    handle: Option<&MemoryGenerationHandle>,
) -> CognitionResult<CacheAdvance> {
    if input.shutdown.is_cancelled() {
        return Ok(CacheAdvance::default());
    }
    let Some(handle) = handle else {
        return Ok(CacheAdvance::default());
    };
    if !input
        .probe
        .cache_work(&handle.graph_path, &(input.clock)())
        .await?
    {
        return Ok(CacheAdvance::default());
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
