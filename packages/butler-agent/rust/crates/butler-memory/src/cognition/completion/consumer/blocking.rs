//! Consumer I/O belongs to the blocking pool, including connection lifetimes.
use crate::cognition::{CognitionCode, CognitionError, CognitionResult};

pub(super) async fn run<T: Send + 'static>(
    work: impl FnOnce() -> CognitionResult<T> + Send + 'static,
) -> CognitionResult<T> {
    tokio::task::spawn_blocking(work).await.map_err(|error| {
        CognitionError::new(CognitionCode::QueryJoinFailed, error.to_string()).with_source(error)
    })?
}

pub(super) async fn ack(root: &std::path::Path, job_id: &str) -> CognitionResult<bool> {
    let root = root.to_owned();
    let job_id = job_id.to_owned();
    run(move || super::super::queue::ack(&root, &job_id)).await
}
