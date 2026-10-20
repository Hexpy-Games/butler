//! Owner-side cold refusal after a warm-only unit was claimed.
use crate::cognition::{
    CognitionCode, CognitionEmbeddingPort, CognitionError, EmbeddingFuture, EmbeddingRequest,
};
use tokio_util::sync::CancellationToken;

pub(super) struct ColdEmbeddings;
impl CognitionEmbeddingPort for ColdEmbeddings {
    fn embed(&self, request: EmbeddingRequest, _: CancellationToken) -> EmbeddingFuture<'_> {
        assert_eq!(
            request.request_class,
            crate::cognition::EmbeddingRequestClass::WarmBackground
        );
        Box::pin(async {
            Err(CognitionError::new(
                CognitionCode::EmbedWorkerCold,
                "embed_worker_cold",
            ))
        })
    }
}

/// Exercise every drain admission flag after the worker disappears.
pub(super) async fn drain_refusals(
    input: &super::Input,
    generation: &crate::cognition::MemoryGenerationHandle,
) {
    for (daily, batch, target) in [
        (false, false, false),
        (false, true, false),
        (true, true, false),
        (false, true, true),
    ] {
        let mut input = input.clone();
        input.daily_batch = daily;
        input
            .vector_batch
            .store(batch, std::sync::atomic::Ordering::Release);
        input.target = target.then(|| crate::cognition::MemoryGenerationTarget::Active {
            expected_generation: generation.generation_id.clone(),
        });
        assert!(
            !super::super::vector::process(&input, &ColdEmbeddings)
                .await
                .unwrap()
        );
    }
}
