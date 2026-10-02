//! One semantic/cache/vector quantum, shared by serving and rebuild consumers.
use super::Input;
use crate::cognition::CognitionResult;

pub(super) async fn process(input: &Input) -> CognitionResult<bool> {
    let (projected, generation) = super::project_next(input).await?;
    let cached = super::cache::process(input, generation.as_ref()).await?;
    let vectorized =
        super::super::vector_schedule::process(input, generation.as_ref(), projected || cached)
            .await?;
    Ok(projected || cached || vectorized)
}
