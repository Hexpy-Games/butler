//! Owner-side cold refusal after a warm-only unit was claimed.
use crate::cognition::{
    CognitionCode, CognitionEmbeddingPort, CognitionError, EmbeddingFuture, EmbeddingRequest,
};
use tokio_util::sync::CancellationToken;

pub(super) struct ColdEmbeddings;
impl CognitionEmbeddingPort for ColdEmbeddings {
    fn embed(&self, _: EmbeddingRequest, _: CancellationToken) -> EmbeddingFuture<'_> {
        Box::pin(async {
            Err(CognitionError::new(
                CognitionCode::EmbedWorkerCold,
                "embed_worker_cold",
            ))
        })
    }
}
